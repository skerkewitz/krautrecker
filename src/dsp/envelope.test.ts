import { describe, expect, it } from 'vitest';
import { encodeBrr } from '../brr/brr';
import { buildSample } from '../brr/sampleBuild';
import { compileSong } from '../compiler/compile';
import { releaseSamples } from '../compiler/envelope';
import { device, fixture } from '../compiler/fixtures';
import { NOTE_OFF, type Release } from '../model/types';
import { LivePlayer, liveSetupFor } from './live';
import { SDsp, type DspEnvelope } from './sdsp';
import { Sequencer } from './sequencer';

const EXP20: Release = { mode: 'exp', rate: 20 };
const TICK = 640;

function loopedSquare() {
  const enc = encodeBrr(
    Int16Array.from({ length: 128 }, (_, i) => (i % 32 < 16 ? 12000 : -12000)),
    0,
  );
  return { brr: enc.data, loopBlock: enc.loopBlock };
}

function render(dsp: { render(l: Float32Array, r: Float32Array, o: number, n: number): void }, n: number): void {
  dsp.render(new Float32Array(n), new Float32Array(n), 0, n);
}

describe('GAIN exponential release in the S-DSP model', () => {
  it('fades gradually and reaches zero within the computed release time', () => {
    const dsp = new SDsp();
    dsp.setSamples([loopedSquare()]);
    dsp.keyOn(0, { sampleSlot: 0, pitch: 0x1000, volL: 127, volR: 127, envelope: { mode: 'adsr', attack: 15, decay: 7, sustainLevel: 7, sustainRate: 0 }, echo: false });
    render(dsp, 1000);
    const start = dsp.envelopeLevel(0);
    expect(start).toBeGreaterThan(0x700);

    dsp.setEnvelope(0, { mode: 'gain', gain: 0xa0 | EXP20.rate });
    const levels: number[] = [];
    for (let n = 0; n < releaseSamples(EXP20); n += 256) {
      render(dsp, 256);
      levels.push(dsp.envelopeLevel(0));
    }
    // Never rises, and still sounds well after the 256 samples a hardware key-off takes.
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeLessThanOrEqual(levels[i - 1]);
    expect(levels[0]).toBeLessThan(start);
    expect(levels[3]).toBeGreaterThan(0x100);
    expect(levels[levels.length - 1]).toBe(0);
  });
});

describe('long release played from compiled IR', () => {
  it('fades after the note-off, is silent before the key-off, and frees the voice', () => {
    const project = fixture([{ device: device('p', 'poly', { release: EXP20 }), cells: [[0, 0, { note: 60 }], [4, 0, { note: NOTE_OFF }]] }]);
    const ir = compileSong(project);
    const dsp = new SDsp();
    dsp.setSamples(project.samples.map((s) => buildSample(s)).map((b) => ({ brr: b.brr, loopBlock: b.loopBlock })));
    const seq = new Sequencer(dsp);
    seq.load(ir);
    seq.play(0, 0, false);

    render(seq, 24 * TICK);
    const held = dsp.envelopeLevel(0);
    expect(held).toBeGreaterThan(0x700);
    render(seq, 3 * TICK);
    const fading = dsp.envelopeLevel(0);
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(held);

    // The key-off is at tick 51; just before it the envelope must already be at zero.
    render(seq, 24 * TICK);
    expect(seq.tick).toBe(51);
    expect(dsp.envelopeLevel(0)).toBe(0);
    render(seq, TICK);
    expect(dsp.active).toBe(false);
  });
});

describe('long release in live play', () => {
  type Call = { op: 'off' | 'env'; voice: number; envelope?: DspEnvelope };
  class RecordingDsp extends SDsp {
    calls: Call[] = [];
    keyOff(voice: number): void {
      this.calls.push({ op: 'off', voice });
      super.keyOff(voice);
    }
    setEnvelope(voice: number, envelope: DspEnvelope): void {
      this.calls.push({ op: 'env', voice, envelope });
      super.setEnvelope(voice, envelope);
    }
  }

  it('a released key switches to the GAIN release and keys off once silent', () => {
    const dev = device('p', 'poly', { release: EXP20 });
    const dsp = new RecordingDsp();
    const live = new LivePlayer(dsp);
    live.setup(liveSetupFor(fixture([{ device: dev, cells: [] }])));
    const ticks = (n: number) => {
      for (let i = 0; i < n; i++) render(live, TICK);
    };
    live.noteOn(dev.id, 60, 100);
    ticks(2);
    live.noteOff(dev.id, 60);
    ticks(1);
    expect(dsp.calls).toEqual([{ op: 'env', voice: 0, envelope: { mode: 'gain', gain: 0xa0 | 20 } }]);
    // The release takes 27 ticks: the key-off fires on the 28th tick after the note-off.
    ticks(26);
    expect(dsp.calls.some((c) => c.op === 'off')).toBe(false);
    ticks(1);
    expect(dsp.calls[dsp.calls.length - 1]).toEqual({ op: 'off', voice: 0 });
  });
});
