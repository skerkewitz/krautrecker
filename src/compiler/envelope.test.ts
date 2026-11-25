import { describe, expect, it } from 'vitest';
import { NOTE_CUT, NOTE_OFF, type Release } from '../model/types';
import { compileSong } from './compile';
import { describeGain, releaseSamples, vibratoOffset } from './envelope';
import { device, fixture } from './fixtures';
import type { IR, VoiceEvent } from './ir';

/** Fixture timing: 125 BPM, 4 LPB, 6 TPL = 640 samples per tick. */
const TICK = 640;
const EXP20: Release = { mode: 'exp', rate: 20 };

const releaseTicks = (r: Release) => Math.ceil((releaseSamples(r) + 1) / TICK);
const types = (lane: VoiceEvent[]) => lane.map((e) => `${e.type}@${e.tick}`);
const volumes = (lane: VoiceEvent[]) => lane.flatMap((e) => (e.type === 'setVolume' ? [e.volL] : []));

describe('release modes', () => {
  it("'hardware' keys off at the note-off, exactly as before", () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly'), cells: [[0, 0, { note: 60 }], [4, 0, { note: NOTE_OFF }]] }]));
    expect(types(ir.voices[0])).toEqual(['keyOn@0', 'keyOff@24']);
  });

  it("'exp' switches to GAIN exponential decrease and keys off once the envelope is at zero", () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly', { release: EXP20 }), cells: [[0, 0, { note: 60 }], [4, 0, { note: NOTE_OFF }]] }]));
    const lane = ir.voices[0];
    // 695 exponential steps from 0x7FF at rate 20 (every 24 samples) = 16680 samples: 27 ticks.
    expect(releaseSamples(EXP20)).toBe(16680);
    expect(releaseTicks(EXP20)).toBe(27);
    expect(types(lane)).toEqual(['keyOn@0', 'setEnvelope@24', 'keyOff@51']);
    expect(lane[1]).toMatchObject({ envelope: { mode: 'gain', gain: 0xa0 | 20 }, release: true });
    expect(lane[1].auto).toBeUndefined();
    // The delayed key-off is driver work, not song data.
    expect(lane[2].auto).toBe(true);
  });

  it("'linear' uses GAIN linear decrease (64 steps from full)", () => {
    const rel: Release = { mode: 'linear', rate: 10 };
    const ir = compileSong(fixture([{ device: device('p', 'poly', { release: rel }), cells: [[0, 0, { note: 60 }], [4, 0, { note: NOTE_OFF }]] }]));
    expect(releaseSamples(rel)).toBe(64 * 256);
    expect(types(ir.voices[0])).toEqual(['keyOn@0', 'setEnvelope@24', `keyOff@${24 + releaseTicks(rel)}`]);
    expect(ir.voices[0][1]).toMatchObject({ envelope: { mode: 'gain', gain: 0x80 | 10 } });
  });

  it('CUT and the cut effect stay hard cuts', () => {
    const dev = device('p', 'poly', { release: EXP20 });
    const cutCell = compileSong(fixture([{ device: dev, cells: [[0, 0, { note: 60 }], [4, 0, { note: NOTE_CUT }]] }]));
    expect(types(cutCell.voices[0])).toEqual(['keyOn@0', 'setVolume@24', 'keyOff@24']);
    const cutFx = compileSong(fixture([{ device: dev, cells: [[0, 0, { note: 60 }], [4, 0, { fx: [{ type: 'cut', value: 2 }] }]] }]));
    expect(types(cutFx.voices[0])).toEqual(['keyOn@0', 'setVolume@26', 'keyOff@26']);
  });

  it('an arp releases its last step with the device release', () => {
    const ir = compileSong(
      fixture([
        {
          device: device('a', 'arp', { release: EXP20, arp: { rate: 2, direction: 'up', octaves: 1 } }),
          columns: 2,
          cells: [[0, 0, { note: 60 }], [0, 1, { note: 64 }], [2, 0, { note: NOTE_OFF }], [2, 1, { note: NOTE_OFF }]],
        },
      ]),
    );
    const lane = ir.voices[0];
    expect(lane.filter((e) => e.type === 'setEnvelope').map((e) => e.tick)).toEqual([12]);
    expect(lane.filter((e) => e.type === 'keyOff').map((e) => e.tick)).toEqual([12 + releaseTicks(EXP20)]);
  });

  it('a mono successor takes over the releasing voice, and the stale key-off is dropped', () => {
    const ir = compileSong(fixture([{ device: device('m', 'mono', { release: EXP20 }), cells: [[0, 0, { note: 60 }], [2, 0, { note: NOTE_OFF }], [4, 0, { note: 64 }]] }]));
    expect(types(ir.voices[0])).toEqual(['keyOn@0', 'setEnvelope@12', 'keyOn@24']);
  });
});

describe('allocation of releasing voices', () => {
  // Two usable voices; column 0 holds, column 1 releases at line 2 (tick 12), silent at tick 39.
  const project = (thirdLine: number) =>
    fixture(
      [
        {
          device: device('p', 'poly', { maxVoices: 8, release: EXP20 }),
          columns: 3,
          cells: [[0, 0, { note: 60 }], [0, 1, { note: 64 }], [2, 1, { note: NOTE_OFF }], [thirdLine, 2, { note: 67 }]],
        },
      ],
      (p) => (p.hardware.reservedSfxVoices = 6),
    );

  it('steals a voice in release before an older held note, silently', () => {
    const ir = compileSong(project(4));
    // Voice 0 is older, but voice 1 is in release, so the new note takes voice 1.
    expect(types(ir.voices[1])).toEqual(['keyOn@0', 'setEnvelope@12', 'keyOn@24']);
    expect(types(ir.voices[0])).toEqual(['keyOn@0']);
    expect(ir.diagnostics.filter((d) => d.kind === 'voiceStolen')).toEqual([]);
  });

  it('keeps the voice busy until silent, then frees it at the key-off tick', () => {
    const ir = compileSong(project(8));
    // At tick 48 the release (keyed off at 39) is over: the note takes voice 1 as a free voice.
    expect(types(ir.voices[1])).toEqual(['keyOn@0', 'setEnvelope@12', 'keyOff@39', 'keyOn@48']);
    // Line 3 (ticks 18-23): both voices are in use, but only one note still wants a voice.
    expect(ir.voiceUsage[3]).toEqual({ used: 2, demand: 1 });
    // Line 7 (ticks 42-47): voice 1 is free again.
    expect(ir.voiceUsage[7]).toEqual({ used: 1, demand: 1 });
  });
});

describe('GAIN envelopes', () => {
  it('Device.gain keys notes on with the raw GAIN byte instead of ADSR', () => {
    const ir = compileSong(fixture([{ device: device('g', 'poly', { gain: 0xc8 }), cells: [[0, 0, { note: 60 }]] }]));
    expect(ir.voices[0][0]).toMatchObject({ type: 'keyOn', envelope: { mode: 'gain', gain: 0xc8 } });
  });

  it('the G effect switches the sounding note; the next note uses the device envelope again', () => {
    const ir = compileSong(
      fixture([{ device: device('p', 'poly'), cells: [[0, 0, { note: 60 }], [2, 0, { fx: [{ type: 'gain', value: 0xb0 }] }], [4, 0, { note: 62 }]] }]),
    );
    const lane = ir.voices[0];
    expect(types(lane)).toEqual(['keyOn@0', 'setEnvelope@12', 'keyOn@24']);
    expect(lane[1]).toMatchObject({ envelope: { mode: 'gain', gain: 0xb0 } });
    expect(lane[1].auto).toBeUndefined();
    expect((lane[1] as { release?: boolean }).release).toBeUndefined();
    expect(lane[2]).toMatchObject({ envelope: { mode: 'adsr' } });
  });

  it('a G effect on the note line keys the note on with that GAIN byte', () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly'), cells: [[0, 0, { note: 60, fx: [{ type: 'gain', value: 0x40 }] }]] }]));
    expect(types(ir.voices[0])).toEqual(['keyOn@0']);
    expect(ir.voices[0][0]).toMatchObject({ envelope: { mode: 'gain', gain: 0x40 } });
  });

  it('describes GAIN bytes', () => {
    expect(describeGain(0x40)).toMatch(/^Direct: holds level 64\/127/);
    expect(describeGain(0x9f)).toMatch(/^Linear decrease, rate 31/);
    expect(describeGain(0xb0)).toMatch(/^Exponential decrease, rate 16/);
    expect(describeGain(0xc8)).toMatch(/^Linear increase, rate 8/);
    expect(describeGain(0xe8)).toMatch(/^Bent-line increase, rate 8/);
  });
});

describe('tremolo', () => {
  it('device tremolo dips the volume periodically, after the delay, as auto events', () => {
    // Device volume 100; depth 127 dips to silence at the trough; period 8 ticks; delay 4.
    const ir = compileSong(fixture([{ device: device('t', 'poly', { tremolo: { depth: 127, rate: 8, delay: 4 } }), cells: [[0, 0, { note: 60 }]] }], () => {}, 4));
    const lane = ir.voices[0];
    expect(lane[0]).toMatchObject({ type: 'keyOn', volL: 100 });
    const vols = lane.filter((e) => e.type === 'setVolume');
    expect(vols.every((e) => e.auto)).toBe(true);
    expect(vols[0].tick).toBe(5);
    // One cycle from tick 4: 100 * (1 - (1 - cos(2 pi t / 8)) / 2).
    expect(volumes(lane).slice(0, 8)).toEqual([85, 50, 15, 0, 15, 50, 85, 100]);
  });

  it('the T effect modulates only on its line, then returns to the note volume', () => {
    // T48: depth 4 * 8 = 32, period 8 * 2 = 16 ticks.
    const ir = compileSong(fixture([{ device: device('t', 'poly', { volume: 127 }), cells: [[0, 0, { note: 60 }], [1, 0, { fx: [{ type: 'tremolo', value: 0x48 }] }]] }], () => {}, 4));
    const lane = ir.voices[0];
    const vols = lane.filter((e) => e.type === 'setVolume');
    expect(vols.map((e) => e.tick)).toEqual([7, 8, 9, 10, 11, 12]);
    expect(volumes(lane)).toEqual([126, 122, 117, 111, 105, 127]);
    expect(Math.min(...volumes(lane))).toBeGreaterThanOrEqual(127 - 32);
  });

  it('without tremolo the volume is untouched', () => {
    const ir = compileSong(fixture([{ device: device('t', 'poly'), cells: [[0, 0, { note: 60 }]] }]));
    expect(ir.voices[0].filter((e) => e.type === 'setVolume')).toEqual([]);
  });
});

describe('vibrato fade-in', () => {
  it('ramps the depth from 0 to full over fadeIn ticks after the delay', () => {
    const v = { depth: 1, rate: 4, delay: 2, fadeIn: 8 };
    expect(vibratoOffset(v, 1)).toBe(0);
    // Peaks of the sine (every 4 ticks from t = 1) grow linearly with the ramp.
    expect(vibratoOffset(v, 3)).toBeCloseTo(1 / 8);
    expect(vibratoOffset(v, 7)).toBeCloseTo(5 / 8);
    expect(vibratoOffset(v, 11)).toBeCloseTo(1);
    expect(vibratoOffset({ ...v, fadeIn: 0 }, 3)).toBeCloseTo(1);
  });

  it('compiles to pitch swings that grow, then stay at full depth', () => {
    const ir = (fadeIn: number): IR =>
      compileSong(fixture([{ device: device('v', 'poly', { vibrato: { depth: 1, rate: 8, delay: 0, fadeIn } }), cells: [[0, 0, { note: 60 }]] }], () => {}, 8));
    const swing = (lane: VoiceEvent[], from: number, to: number) => {
      const ps = lane.flatMap((e) => (e.type === 'setPitch' && e.tick >= from && e.tick < to ? [e.pitch] : []));
      return Math.max(...ps) - Math.min(...ps);
    };
    const faded = ir(16).voices[0];
    const full = ir(0).voices[0];
    expect(swing(faded, 0, 8)).toBeLessThan(swing(faded, 8, 16));
    expect(swing(faded, 8, 16)).toBeLessThan(swing(faded, 16, 24));
    expect(swing(faded, 24, 32)).toBe(swing(full, 24, 32));
    expect(faded.filter((e) => e.type === 'setPitch').every((e) => e.auto)).toBe(true);
  });
});
