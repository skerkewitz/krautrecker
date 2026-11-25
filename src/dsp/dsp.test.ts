import { describe, expect, it } from 'vitest';
import { encodeBrr } from '../brr/brr';
import { SDsp, type DspEnvelope } from './sdsp';
import { COUNTER_RATES, GAUSS } from './tables';

const ADSR = (attack: number, decay = 7, sustainLevel = 7, sustainRate = 0): DspEnvelope => ({ mode: 'adsr', attack, decay, sustainLevel, sustainRate });

/** A looping square wave with the given period in samples. */
function squareSample(period: number, cycles = 4) {
  const pcm = Int16Array.from({ length: period * cycles }, (_, i) => (i % period < period / 2 ? 12000 : -12000));
  const enc = encodeBrr(pcm, 0);
  return { brr: enc.data, loopBlock: enc.loopBlock };
}

function render(dsp: SDsp, n: number): Float32Array {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  dsp.render(l, r, 0, n);
  return l;
}

function countRisingZeroCrossings(x: Float32Array): number {
  let c = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] <= 0 && x[i] > 0) c++;
  return c;
}

describe('Gaussian interpolation table', () => {
  it('has 512 entries rising from 0 to 1305', () => {
    expect(GAUSS.length).toBe(512);
    expect(GAUSS[0]).toBe(0);
    expect(GAUSS[511]).toBe(1305);
    for (let i = 1; i < 512; i++) expect(GAUSS[i]).toBeGreaterThanOrEqual(GAUSS[i - 1]);
  });

  it('weights sum to about unity gain (2048) at every fractional position', () => {
    for (let off = 0; off < 256; off++) {
      const sum = GAUSS[255 - off] + GAUSS[511 - off] + GAUSS[256 + off] + GAUSS[off];
      expect(sum).toBeGreaterThanOrEqual(2047);
      expect(sum).toBeLessThanOrEqual(2049);
    }
  });
});

describe('pitch register', () => {
  it('0x1000 plays the sample at its native rate', () => {
    const dsp = new SDsp();
    dsp.setSamples([squareSample(32)]);
    dsp.keyOn(0, { sampleSlot: 0, pitch: 0x1000, volL: 127, volR: 127, envelope: ADSR(15), echo: false });
    render(dsp, 1000); // settle
    const out = render(dsp, 32000);
    // 32 samples per cycle at 32 kHz = 1000 Hz.
    expect(Math.abs(countRisingZeroCrossings(out) - 1000)).toBeLessThanOrEqual(1);
  });

  it('0x2000 plays one octave up', () => {
    const dsp = new SDsp();
    dsp.setSamples([squareSample(64)]);
    dsp.keyOn(0, { sampleSlot: 0, pitch: 0x2000, volL: 127, volR: 127, envelope: ADSR(15), echo: false });
    render(dsp, 1000);
    const out = render(dsp, 32000);
    expect(Math.abs(countRisingZeroCrossings(out) - 1000)).toBeLessThanOrEqual(1);
  });

  it('a one-shot sample silences the voice when it ends', () => {
    const pcm = Int16Array.from({ length: 64 }, () => 10000);
    const enc = encodeBrr(pcm, null);
    const dsp = new SDsp();
    dsp.setSamples([{ brr: enc.data, loopBlock: -1 }]);
    dsp.keyOn(0, { sampleSlot: 0, pitch: 0x1000, volL: 127, volR: 127, envelope: ADSR(15), echo: false });
    render(dsp, 200);
    expect(dsp.envelopeLevel(0)).toBe(0);
  });
});

describe('ADSR envelope timing (hardware rate tables)', () => {
  function levelAfter(env: DspEnvelope, samples: number, keyOffAt = Infinity): number {
    const dsp = new SDsp();
    dsp.setSamples([squareSample(32)]);
    dsp.keyOn(0, { sampleSlot: 0, pitch: 0x1000, volL: 127, volR: 127, envelope: env, echo: false });
    if (keyOffAt < samples) {
      render(dsp, keyOffAt);
      dsp.keyOff(0);
      render(dsp, samples - keyOffAt);
    } else render(dsp, samples);
    return dsp.envelopeLevel(0);
  }

  it('attack 15 is (almost) instant: +0x400 per sample', () => {
    expect(levelAfter(ADSR(15), 3)).toBe(0x7ff);
  });

  it('attack 10 steps +0x20 every 20 samples (about 40 ms to full)', () => {
    expect(COUNTER_RATES[10 * 2 + 1]).toBe(20);
    // After 640 samples: 32 steps of 0x20 = 0x400, +- one step for the counter phase.
    expect(Math.abs(levelAfter(ADSR(10), 640) - 0x400)).toBeLessThanOrEqual(0x20);
    // 64 steps = 1280 samples reach the top. The overshooting step often lands on a sample where
    // the counter does not fire, so the envelope switches to decay just below 0x7FF (as on hardware).
    expect(levelAfter(ADSR(10), 1300)).toBeGreaterThanOrEqual(0x7c0);
  });

  it('attack 0 takes about 4.1 seconds', () => {
    // Rate 1 fires every 2048 samples; 64 steps = 131072 samples = 4.096 s.
    expect(levelAfter(ADSR(0), 120000)).toBeLessThan(0x7ff);
    expect(levelAfter(ADSR(0), 133200)).toBeGreaterThanOrEqual(0x7c0);
  });

  it('decays to the sustain level and holds there with sustain rate 0', () => {
    // Sustain level 3 -> (3+1)/8 of full; decay 7 is the fastest (rate 30 = every 2 samples).
    // The mode switches to sustain when the computed level reaches the target, even on a sample
    // where the counter does not write it, so the held level can sit one step above.
    const lvl = levelAfter(ADSR(15, 7, 3, 0), 32000);
    expect([3, 4]).toContain(lvl >> 8);
    expect(levelAfter(ADSR(15, 7, 3, 0), 64000)).toBe(lvl);
  });

  it('releases by 8 per sample: silent about 256 samples after key-off', () => {
    expect(levelAfter(ADSR(15), 1000 + 100, 1000)).toBeGreaterThan(0);
    expect(levelAfter(ADSR(15), 1000 + 260, 1000)).toBe(0);
  });
});

describe('echo', () => {
  it('returns the signal after the configured delay (16 ms = 512 samples per step)', () => {
    const dsp = new SDsp();
    dsp.setSamples([squareSample(32)]);
    dsp.setMainVolume(0, 0); // only hear the echo
    dsp.setEcho({ delay: 1, feedback: 0, volumeL: 127, volumeR: 127, fir: [127, 0, 0, 0, 0, 0, 0, 0] });
    dsp.keyOn(0, { sampleSlot: 0, pitch: 0x1000, volL: 127, volR: 127, envelope: ADSR(15), echo: true });
    const out = render(dsp, 1200);
    const firstNonZero = out.findIndex((v) => v !== 0);
    // Delay of 512 samples, plus the FIR tap-0 offset of 7 and a few samples of interpolation latency.
    expect(firstNonZero).toBeGreaterThanOrEqual(512);
    expect(firstNonZero).toBeLessThan(530);
  });
});
