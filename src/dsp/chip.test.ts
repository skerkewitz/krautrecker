import { describe, expect, it } from 'vitest';
import { encodeBrr } from '../brr/brr';
import { buildSample } from '../brr/sampleBuild';
import { compileSong } from '../compiler/compile';
import { device, fixture, TEST_SAMPLE_ID } from '../compiler/fixtures';
import { newZone } from '../model/defaults';
import { LivePlayer, liveSetupFor } from './live';
import { modulatedPitch, NOISE_INITIAL, noiseFrequency, noiseSample, noiseStep } from './noise';
import { SDsp, type DspEnvelope } from './sdsp';
import { Sequencer } from './sequencer';
import { COUNTER_RATES } from './tables';

const ADSR = (attack: number, decay = 7, sustainLevel = 7, sustainRate = 0): DspEnvelope => ({ mode: 'adsr', attack, decay, sustainLevel, sustainRate });

/** A looping square wave with the given period in samples. */
function squareSample(period: number, cycles = 4) {
  const pcm = Int16Array.from({ length: period * cycles }, (_, i) => (i % period < period / 2 ? 12000 : -12000));
  const enc = encodeBrr(pcm, 0);
  return { brr: enc.data, loopBlock: enc.loopBlock };
}

/** A looping constant (DC) sample. */
function dcSample(level: number) {
  const enc = encodeBrr(Int16Array.from({ length: 64 }, () => level), 0);
  return { brr: enc.data, loopBlock: enc.loopBlock };
}

function render(dsp: SDsp, n: number): Float32Array {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  dsp.render(l, r, 0, n);
  return l;
}

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

function changes(x: Float32Array): number {
  let c = 0;
  for (let i = 1; i < x.length; i++) if (x[i] !== x[i - 1]) c++;
  return c;
}

function risingZeroCrossings(x: Float32Array): number {
  let c = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] <= 0 && x[i] > 0) c++;
  return c;
}

describe('noise generator', () => {
  it('is a maximal-length 15-bit shift register', () => {
    let n = NOISE_INITIAL;
    let period = 0;
    do {
      n = noiseStep(n);
      period++;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(0x8000);
    } while (n !== NOISE_INITIAL && period < 40000);
    expect(period).toBe(32767);
  });

  it('outputs the register doubled as a signed 16-bit value', () => {
    expect(noiseSample(0x4000)).toBe(-32768);
    expect(noiseSample(0x3fff)).toBe(0x7ffe);
    expect(noiseSample(1)).toBe(2);
  });

  it('runs at the envelope rate table: clock 31 = 32 kHz, clock 0 never steps', () => {
    expect(noiseFrequency(31)).toBe(32000);
    expect(noiseFrequency(20)).toBeCloseTo(32000 / 24);
    expect(noiseFrequency(1)).toBeCloseTo(15.625);
    expect(noiseFrequency(0)).toBe(0);
  });
});

describe('noise voices', () => {
  function noiseVoice(clock: number, env: DspEnvelope) {
    const dsp = new SDsp();
    dsp.setSamples([squareSample(32)]);
    dsp.setNoiseClock(clock);
    dsp.keyOn(0, { sampleSlot: 0, pitch: 0x1000, volL: 127, volR: 127, envelope: env, echo: false });
    dsp.setNoise(0, true);
    return dsp;
  }

  it('play pseudo-random values instead of the sample', () => {
    const out = render(noiseVoice(31, ADSR(15)), 4000);
    const distinct = new Set(out.slice(100));
    // The square wave has a handful of distinct values; noise at 32 kHz has thousands.
    expect(distinct.size).toBeGreaterThan(2000);
    let mean = 0;
    for (let i = 100; i < 4000; i++) mean += out[i];
    expect(Math.abs(mean / 3900)).toBeLessThan(0.05);
    expect(rms(out, 100, 4000)).toBeGreaterThan(0.3);
  });

  it('are shaped by the envelope, and key-off silences them', () => {
    // Attack 8 (rate 17, every 48 samples): about 3072 samples to full level.
    const dsp = noiseVoice(31, ADSR(8));
    const out = render(dsp, 4000);
    expect(rms(out, 0, 500)).toBeLessThan(rms(out, 3500, 4000) * 0.3);
    dsp.keyOff(0);
    const after = render(dsp, 600);
    expect(rms(after, 300, 600)).toBe(0);
  });

  it('change value at the rate of the noise clock', () => {
    const count = (clock: number) => {
      const dsp = noiseVoice(clock, ADSR(15));
      render(dsp, 1000); // let the envelope settle at its sustain level
      return changes(render(dsp, 24000));
    };
    expect(Math.abs(count(20) - 24000 / COUNTER_RATES[20]) / (24000 / COUNTER_RATES[20])).toBeLessThan(0.03);
    expect(Math.abs(count(10) - 24000 / COUNTER_RATES[10])).toBeLessThanOrEqual(2);
    expect(count(0)).toBe(0);
  });

  it('still run their sample: a one-shot sample ending silences the noise', () => {
    const enc = encodeBrr(Int16Array.from({ length: 64 }, () => 10000), null);
    const dsp = new SDsp();
    dsp.setSamples([{ brr: enc.data, loopBlock: -1 }]);
    dsp.setNoiseClock(31);
    dsp.keyOn(0, { sampleSlot: 0, pitch: 0x1000, volL: 127, volR: 127, envelope: ADSR(15), echo: false });
    dsp.setNoise(0, true);
    const out = render(dsp, 400);
    expect(rms(out, 0, 60)).toBeGreaterThan(0.1);
    expect(rms(out, 200, 400)).toBe(0);
  });
});

describe('pitch modulation (PMON)', () => {
  /** Voice 0 plays a silent DC modulator, voice 1 a 1 kHz square carrier. Returns the carrier's frequency. */
  function carrierHz(level: number, pmonVoice: number | null) {
    const dsp = new SDsp();
    dsp.setSamples([dcSample(level), squareSample(32)]);
    dsp.keyOn(0, { sampleSlot: 0, pitch: 0x1000, volL: 0, volR: 0, envelope: ADSR(15), echo: false });
    dsp.keyOn(1, { sampleSlot: 1, pitch: 0x1000, volL: 127, volR: 127, envelope: ADSR(15), echo: false });
    if (pmonVoice !== null) dsp.setPitchMod(pmonVoice, true);
    render(dsp, 1000);
    const hz = risingZeroCrossings(render(dsp, 32000));
    return { hz, modOut: dsp.voices[0].lastOut };
  }

  it('scales the pitch of voice n by the output of voice n-1, even at volume 0', () => {
    expect(carrierHz(16000, null).hz).toBeGreaterThanOrEqual(999);
    const up = carrierHz(16000, 1);
    const expected = (1000 * modulatedPitch(0x1000, up.modOut)) / 0x1000;
    expect(expected).toBeGreaterThan(1400);
    expect(Math.abs(up.hz - expected)).toBeLessThanOrEqual(3);
    const down = carrierHz(-16000, 1);
    expect(Math.abs(down.hz - (1000 * modulatedPitch(0x1000, down.modOut)) / 0x1000)).toBeLessThanOrEqual(3);
    expect(down.hz).toBeLessThan(600);
  });

  it('is ignored on voice 0, which has no previous voice', () => {
    const dsp = new SDsp();
    dsp.setSamples([squareSample(32)]);
    dsp.keyOn(0, { sampleSlot: 0, pitch: 0x1000, volL: 127, volR: 127, envelope: ADSR(15), echo: false });
    dsp.setPitchMod(0, true);
    render(dsp, 1000);
    expect(Math.abs(risingZeroCrossings(render(dsp, 32000)) - 1000)).toBeLessThanOrEqual(1);
  });

  it('follows the modulator formula of the hardware', () => {
    expect(modulatedPitch(0x1000, 0)).toBe(0x1000);
    expect(modulatedPitch(0x1000, -32768)).toBe(0);
    expect(modulatedPitch(0x3fff, 32767)).toBeLessThanOrEqual(0x7fff);
  });
});

describe('chip voices in playback', () => {
  const noiseDevice = () => device('nz', 'mono', { zones: [{ ...newZone(TEST_SAMPLE_ID), noise: 20 }] });

  it('the sequencer applies noise and the noise clock; silence() clears the voice bits', () => {
    const project = fixture([{ device: noiseDevice(), cells: [[0, 0, { note: 60 }]] }]);
    const dsp = new SDsp();
    dsp.setSamples(project.samples.map((s) => buildSample(s)).map((b) => ({ brr: b.brr, loopBlock: b.loopBlock })));
    const seq = new Sequencer(dsp);
    seq.load(compileSong(project));
    seq.play(0, 0, false);
    const buf = new Float32Array(1280);
    seq.render(buf, new Float32Array(1280), 0, 1280);
    expect(dsp.voices[0].noise).toBe(true);
    expect(dsp.noiseClock).toBe(20);
    seq.play(0, 0, false);
    expect(dsp.voices[0].noise).toBe(false);
  });

  it('live play turns noise on and sets the clock', () => {
    const project = fixture([{ device: noiseDevice(), cells: [] }]);
    const live = new LivePlayer(new SDsp());
    live.setup(liveSetupFor(project));
    live.noteOn('nz', 60, 100);
    live.render(new Float32Array(640), new Float32Array(640), 0, 640);
    expect(live.dsp.voices[0].noise).toBe(true);
    expect(live.dsp.noiseClock).toBe(20);
  });

  it('live play places a pitch-modulated device above its source and enables PMON', () => {
    const project = fixture([
      { device: device('mod', 'mono'), cells: [] },
      { device: device('car', 'mono', { pitchModSource: 'mod' }), cells: [] },
    ]);
    const live = new LivePlayer(new SDsp());
    live.setup(liveSetupFor(project));
    // The carrier is pressed first; it is still allocated after its source.
    live.noteOn('car', 60, 100);
    live.noteOn('mod', 48, 100);
    live.render(new Float32Array(640), new Float32Array(640), 0, 640);
    expect(live.dsp.voices[0].pitchMod).toBe(false);
    expect(live.dsp.voices[1].pitchMod).toBe(true);
  });
});
