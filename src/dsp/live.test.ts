import { describe, expect, it } from 'vitest';
import { device, fixture, TEST_SAMPLE_ID } from '../compiler/fixtures';
import type { Device, Sample } from '../model/types';
import { int16ToBase64 } from '../util/base64';
import { LivePlayer, liveSetupFor } from './live';
import { SDsp, type KeyOnParams } from './sdsp';

type Call = { op: 'on'; voice: number; pitch: number } | { op: 'off'; voice: number } | { op: 'pitch'; voice: number; pitch: number };

/** An S-DSP that also records the register writes it receives. */
class RecordingDsp extends SDsp {
  calls: Call[] = [];
  keyOn(voice: number, p: KeyOnParams): void {
    this.calls.push({ op: 'on', voice, pitch: p.pitch });
    super.keyOn(voice, p);
  }
  keyOff(voice: number): void {
    this.calls.push({ op: 'off', voice });
    super.keyOff(voice);
  }
  setPitch(voice: number, pitch: number): void {
    this.calls.push({ op: 'pitch', voice, pitch });
    super.setPitch(voice, pitch);
  }
}

/** Pitch register for a note on the test sample (root 60 plays at 0x1000). */
const P = (note: number) => Math.round(0x1000 * 2 ** ((note - 60) / 12));
const TICK = 640; // samples per tick at 125 BPM, 4 LPB, 6 TPL

function setup(dev: Device, extraSamples: Sample[] = []) {
  const project = fixture([{ device: dev, cells: [] }], (p) => p.samples.push(...extraSamples));
  const dsp = new RecordingDsp();
  const live = new LivePlayer(dsp);
  live.setup(liveSetupFor(project));
  const buf = [new Float32Array(TICK * 32), new Float32Array(TICK * 32)];
  const ticks = (n: number) => live.render(buf[0], buf[1], 0, Math.round(n * TICK));
  return { dsp, live, ticks, id: dev.id };
}

describe('live play follows the device mode', () => {
  it('poly: a chord takes one voice per key', () => {
    const { dsp, live, ticks, id } = setup(device('p', 'poly', { maxVoices: 8 }));
    live.noteOn(id, 60, 100);
    live.noteOn(id, 64, 100);
    live.noteOn(id, 67, 100);
    ticks(1);
    expect(dsp.calls).toEqual([
      { op: 'on', voice: 0, pitch: P(60) },
      { op: 'on', voice: 1, pitch: P(64) },
      { op: 'on', voice: 2, pitch: P(67) },
    ]);
  });

  it('poly: respects the device voice limit', () => {
    const { dsp, live, ticks, id } = setup(device('p', 'poly', { maxVoices: 2 }));
    for (const n of [60, 64, 67]) live.noteOn(id, n, 100);
    ticks(1);
    expect(dsp.calls.filter((c) => c.op === 'on').map((c) => c.voice)).toEqual([0, 1, 0]);
  });

  it('mono: one voice; releasing the sounding key falls back to the held one', () => {
    const { dsp, live, ticks, id } = setup(device('m', 'mono'));
    live.noteOn(id, 60, 100);
    ticks(1);
    live.noteOn(id, 64, 100);
    ticks(1);
    live.noteOff(id, 64);
    ticks(1);
    live.noteOff(id, 60);
    ticks(2);
    expect(dsp.calls).toEqual([
      { op: 'on', voice: 0, pitch: P(60) },
      { op: 'on', voice: 0, pitch: P(64) },
      { op: 'on', voice: 0, pitch: P(60) },
      { op: 'off', voice: 0 },
    ]);
  });

  it('mono: releasing a key that is not sounding changes nothing', () => {
    const { dsp, live, ticks, id } = setup(device('m', 'mono'));
    live.noteOn(id, 60, 100);
    live.noteOn(id, 64, 100);
    ticks(1);
    dsp.calls = [];
    live.noteOff(id, 60);
    ticks(2);
    expect(dsp.calls).toEqual([]);
  });

  it('legato: a second key glides the pitch without a new key-on', () => {
    const { dsp, live, ticks, id } = setup(device('l', 'legato'));
    live.noteOn(id, 60, 100);
    ticks(1);
    live.noteOn(id, 72, 100);
    ticks(1);
    expect(dsp.calls).toEqual([
      { op: 'on', voice: 0, pitch: P(60) },
      { op: 'pitch', voice: 0, pitch: P(72) },
    ]);
  });

  it('arp: held keys play as steps on one voice at the arp rate', () => {
    const { dsp, live, ticks, id } = setup(device('a', 'arp', { arp: { rate: 2, direction: 'up', octaves: 1 } }));
    for (const n of [67, 60, 64]) live.noteOn(id, n, 100);
    ticks(8); // steps on ticks 1, 3, 5, 7
    const ons = dsp.calls.filter((c) => c.op === 'on');
    expect(ons.every((c) => c.voice === 0)).toBe(true);
    expect(ons.map((c) => c.pitch).slice(0, 4)).toEqual([P(60), P(64), P(67), P(60)]);
    for (const n of [67, 60, 64]) live.noteOff(id, n);
    ticks(2);
    expect(dsp.calls[dsp.calls.length - 1]).toEqual({ op: 'off', voice: 0 });
  });

  it('drum: one-shot hits ring out after the key is released', () => {
    const oneShot: Sample = {
      id: 'smp_hit',
      name: 'hit',
      pcm: int16ToBase64(Int16Array.from({ length: 6400 }, (_, i) => (i % 32 < 16 ? 8000 : -8000))),
      sampleRate: 32000,
      targetRate: 32000,
      rootNote: 60,
      fineTune: 0,
      loop: { enabled: false, start: 0 },
    };
    const kit = device('kit', 'drum', { zones: [{ sampleId: 'smp_hit', keyRange: [36, 36], fixedPitch: 60, volume: 127, pan: 0 }] });
    const { dsp, live, ticks, id } = setup(kit, [oneShot]);
    live.noteOn(id, 36, 100);
    ticks(1);
    live.noteOff(id, 36);
    ticks(2);
    expect(dsp.calls).toEqual([{ op: 'on', voice: 0, pitch: 0x1000 }]);
  });

  it('a changed device mode ends the notes held in the old mode', () => {
    const dev = device('x', 'poly');
    const { dsp, live, ticks, id } = setup(dev);
    live.noteOn(id, 60, 100);
    ticks(1);
    const project = fixture([{ device: { ...dev, mode: 'arp' }, cells: [] }]);
    live.setup(liveSetupFor(project));
    ticks(1);
    expect(dsp.calls).toEqual([
      { op: 'on', voice: 0, pitch: P(60) },
      { op: 'off', voice: 0 },
    ]);
    expect(TEST_SAMPLE_ID).toBe('smp_test');
  });
});
