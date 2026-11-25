import { describe, expect, it } from 'vitest';
import { demoProject } from '../model/demo';
import { newZone } from '../model/defaults';
import { NOTE_OFF, type Cell, type Device, type Zone } from '../model/types';
import { compileSong } from './compile';
import { device, fixture, TEST_SAMPLE_ID } from './fixtures';
import type { IR, VoiceEvent } from './ir';

const noiseZone = (clock: number, patch: Partial<Zone> = {}): Zone => ({ ...newZone(TEST_SAMPLE_ID), noise: clock, ...patch });
const N = (value: number): Cell => ({ fx: [{ type: 'noise', value }] });

/** A lane as compact strings: "t0 keyOn", "t0 noise on 20", "t12 pitchMod off". */
function lane(ir: IR, v: number): string[] {
  return ir.voices[v].map((e: VoiceEvent) => {
    switch (e.type) {
      case 'noise':
        return `t${e.tick} noise ${e.enabled ? `on ${e.clock}` : 'off'}`;
      case 'pitchMod':
        return `t${e.tick} pitchMod ${e.enabled ? 'on' : 'off'}`;
      case 'keyOn':
        return `t${e.tick} keyOn ${e.deviceId}`;
      default:
        return `t${e.tick} ${e.type}`;
    }
  });
}

const clocks = (ir: IR) => ir.global.filter((g) => g.type === 'noiseClock').map((g) => [g.tick, (g as { clock: number }).clock]);
const diags = (ir: IR, kind: string) => ir.diagnostics.filter((d) => d.kind === kind);

describe('noise', () => {
  it('a noise zone turns noise on right after the key-on and writes the global clock', () => {
    const ir = compileSong(fixture([{ device: device('nz', 'mono', { zones: [noiseZone(20)] }), cells: [[0, 0, { note: 60 }], [2, 0, { note: NOTE_OFF }]] }]));
    expect(lane(ir, 0)).toEqual(['t0 keyOn nz', 't0 noise on 20', 't12 keyOff']);
    expect(clocks(ir)).toEqual([[0, 20]]);
    expect(ir.diagnostics).toEqual([]);
  });

  it('a voice that played noise gets noise off before its next normal note', () => {
    const dev = device('m', 'mono', { zones: [noiseZone(12, { keyRange: [0, 59] }), newZone(TEST_SAMPLE_ID, [60, 127])] });
    const ir = compileSong(fixture([{ device: dev, cells: [[0, 0, { note: 40 }], [2, 0, { note: 41 }], [4, 0, { note: 72 }], [6, 0, { note: 74 }]] }]));
    expect(lane(ir, 0)).toEqual(['t0 keyOn m', 't0 noise on 12', 't12 keyOn m', 't12 noise on 12', 't24 keyOn m', 't24 noise off', 't36 keyOn m']);
    // Each noise note writes its own clock, so starting or looping playback mid-song stays right.
    expect(clocks(ir)).toEqual([
      [0, 12],
      [12, 12],
    ]);
  });

  it('effect N switches the sounding note to noise and back', () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly'), cells: [[0, 0, { note: 60 }], [2, 0, N(0x05)], [4, 0, N(0x20)]] }]));
    expect(lane(ir, 0)).toEqual(['t0 keyOn p', 't12 noise on 5', 't24 noise off']);
    expect(clocks(ir)).toEqual([[12, 5]]);
  });

  it('effect N on the note line makes a noise note from its key-on', () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly'), cells: [[0, 0, { note: 60, fx: [{ type: 'noise', value: 0x1f }] }]] }]));
    expect(lane(ir, 0)).toEqual(['t0 keyOn p', 't0 noise on 31']);
    expect(clocks(ir)).toEqual([[0, 31]]);
  });

  it('overlapping noise notes with different clocks: the last write wins, with a warning', () => {
    const ir = compileSong(
      fixture([
        { device: device('a', 'mono', { zones: [noiseZone(10)] }), cells: [[0, 0, { note: 60 }]] },
        { device: device('b', 'mono', { zones: [noiseZone(20)] }), cells: [[2, 0, { note: 60 }]] },
      ]),
    );
    expect(clocks(ir)).toEqual([
      [0, 10],
      [12, 20],
    ]);
    const d = diags(ir, 'noiseClockConflict');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'warning', tick: 12, voice: 1 });
  });

  it('on the same tick the first note allocated keeps its clock', () => {
    const ir = compileSong(
      fixture([
        { device: device('a', 'mono', { zones: [noiseZone(10)] }), cells: [[0, 0, { note: 60 }]] },
        { device: device('b', 'mono', { zones: [noiseZone(20)] }), cells: [[0, 0, { note: 60 }]] },
      ]),
    );
    expect(clocks(ir)).toEqual([[0, 10]]);
    expect(diags(ir, 'noiseClockConflict')).toHaveLength(1);
  });

  it('notes that no longer overlap do not conflict', () => {
    const ir = compileSong(
      fixture([
        { device: device('a', 'mono', { zones: [noiseZone(10)] }), cells: [[0, 0, { note: 60 }], [1, 0, { note: NOTE_OFF }]] },
        { device: device('b', 'mono', { zones: [noiseZone(20)] }), cells: [[2, 0, { note: 60 }]] },
      ]),
    );
    expect(clocks(ir)).toEqual([
      [0, 10],
      [12, 20],
    ]);
    expect(diags(ir, 'noiseClockConflict')).toEqual([]);
  });

  it('noise over a one-shot sample is reported, because the noise ends with the sample', () => {
    const ir = compileSong(
      fixture([{ device: device('nz', 'drum', { zones: [{ ...noiseZone(25), sampleId: 'oneshot' }] }), cells: [[0, 0, { note: 60 }]] }], (p) =>
        p.samples.push({ ...p.samples[0], id: 'oneshot', name: 'hit', loop: { enabled: false, start: 0 } }),
      ),
    );
    const d = diags(ir, 'noiseOneShot');
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe('info');
  });

  it('songs without noise, pitch modulation or surround get no chip events', () => {
    const ir = compileSong(demoProject());
    expect(ir.voices.flat().filter((e) => e.type === 'noise' || e.type === 'pitchMod')).toEqual([]);
    expect(clocks(ir)).toEqual([]);
    expect(ir.voices.flat().some((e) => (e.type === 'keyOn' || e.type === 'setVolume') && e.volR < 0)).toBe(false);
  });
});

describe('pitch modulation', () => {
  const mod = (): Device => device('mod', 'mono');
  const car = (): Device => device('car', 'mono', { pitchModSource: 'mod' });
  const other = (): Device => device('oth', 'poly');

  it('places the modulated note above its source, even when its own track comes first', () => {
    const ir = compileSong(
      fixture([
        { device: car(), cells: [[0, 0, { note: 72 }]] },
        { device: mod(), cells: [[0, 0, { note: 48 }]] },
      ]),
    );
    expect(lane(ir, 0)).toEqual(['t0 keyOn mod']);
    expect(lane(ir, 1)).toEqual(['t0 keyOn car', 't0 pitchMod on']);
    expect(ir.diagnostics).toEqual([]);
  });

  it('takes the voice above the source rather than the lowest free voice', () => {
    const ir = compileSong(
      fixture([
        { device: other(), cells: [[0, 0, { note: 60 }], [2, 0, { note: NOTE_OFF }]] },
        { device: mod(), cells: [[0, 0, { note: 48 }]] },
        { device: car(), cells: [[4, 0, { note: 72 }]] },
      ]),
    );
    expect(lane(ir, 1)).toEqual(['t0 keyOn mod']);
    expect(lane(ir, 2)).toEqual(['t24 keyOn car', 't24 pitchMod on']);
    expect(lane(ir, 0)).toEqual(['t0 keyOn oth', 't12 keyOff']);
  });

  it('plays unmodulated, with a warning, when the voice above the source is held by another note', () => {
    const ir = compileSong(
      fixture([
        { device: mod(), cells: [[0, 0, { note: 48 }]] },
        { device: other(), cells: [[0, 0, { note: 60 }]] },
        { device: car(), cells: [[0, 0, { note: 72 }]] },
      ]),
    );
    expect(lane(ir, 1)).toEqual(['t0 keyOn oth']);
    expect(lane(ir, 2)).toEqual(['t0 keyOn car']);
    const d = diags(ir, 'pitchModUnavailable');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'warning', voice: 2 });
  });

  it('turns PMON off when another device takes the voice below a modulated note', () => {
    const ir = compileSong(
      fixture([
        { device: mod(), cells: [[0, 0, { note: 48 }], [2, 0, { note: NOTE_OFF }]] },
        { device: car(), cells: [[0, 0, { note: 72 }]] },
        { device: other(), cells: [[4, 0, { note: 60 }]] },
      ]),
    );
    expect(lane(ir, 0)).toEqual(['t0 keyOn mod', 't12 keyOff', 't24 keyOn oth']);
    expect(lane(ir, 1)).toEqual(['t0 keyOn car', 't0 pitchMod on', 't24 pitchMod off']);
    expect(diags(ir, 'pitchModUnavailable')).toHaveLength(1);
  });

  it('a normal note on a voice that had PMON turns it off', () => {
    const ir = compileSong(
      fixture([
        { device: mod(), cells: [[0, 0, { note: 48 }]] },
        { device: car(), cells: [[0, 0, { note: 72 }], [2, 0, { note: NOTE_OFF }]] },
        { device: other(), cells: [[4, 0, { note: 60 }]] },
      ]),
    );
    expect(lane(ir, 1)).toEqual(['t0 keyOn car', 't0 pitchMod on', 't12 keyOff', 't24 keyOn oth', 't24 pitchMod off']);
  });
});

describe('surround', () => {
  it('inverts the right volume in key-on and every volume change', () => {
    const ir = compileSong(fixture([{ device: device('s', 'poly', { surround: true, volume: 127 }), cells: [[0, 0, { note: 60 }], [2, 0, { volume: 64 }]] }]));
    const [on, vol] = ir.voices[0];
    expect(on).toMatchObject({ type: 'keyOn', volL: 127, volR: -127 });
    expect(vol).toMatchObject({ type: 'setVolume', volL: 64, volR: -64 });
  });

  it('keeps a silent right side at zero', () => {
    const ir = compileSong(fixture([{ device: device('s', 'poly', { surround: true, pan: -64 }), cells: [[0, 0, { note: 60 }]] }]));
    expect(ir.voices[0][0]).toMatchObject({ type: 'keyOn', volR: 0 });
    expect(Object.is((ir.voices[0][0] as { volR: number }).volR, -0)).toBe(false);
  });
});
