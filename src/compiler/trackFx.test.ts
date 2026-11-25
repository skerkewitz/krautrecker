import { describe, expect, it } from 'vitest';
import { newPattern, newTrack } from '../model/defaults';
import type { Cell, Effect, EffectType, Project, Track } from '../model/types';
import { LivePlayer, liveSetupFor } from '../dsp/live';
import { SDsp, type KeyOnParams } from '../dsp/sdsp';
import { compileSong } from './compile';
import { device, fixture, TEST_SAMPLE_ID } from './fixtures';
import { stereoVolume } from './instrument';
import type { IR, KeyOnEvent, VoiceEvent } from './ir';

type CellSpec = [number, number, Cell];

/** Pitch register for a note on the test sample (root 60 plays at 0x1000). */
const P = (note: number) => Math.round(0x1000 * 2 ** ((note - 60) / 12));
/** Note volume for the test device (volume 100, zone 127) at a cell and track volume. */
const V = (cellVol: number, trackVol = 127) => Math.round((100 * 127 * cellVol * trackVol) / 127 ** 3);
const fx = (type: EffectType, value: number): { fx: Effect[] } => ({ fx: [{ type, value }] });

function one(cells: CellSpec[], track: Partial<Track> = {}, columns = 1): Project {
  return fixture([{ device: device('p', 'poly', { maxVoices: 8 }), columns, cells }], (p) => Object.assign(p.patterns[0].tracks[0], track));
}

/** Two 8-line patterns of one poly track, with per-pattern track settings. */
function two(a: CellSpec[], b: CellSpec[], ta: Partial<Track> = {}, tb: Partial<Track> = {}): Project {
  return fixture(
    [{ device: device('p', 'poly', { maxVoices: 8 }), cells: a }],
    (p) => {
      Object.assign(p.patterns[0].tracks[0], ta);
      const second = newPattern('Q', 8, [{ ...newTrack('p', 1, 8), ...tb }], 'pat_2');
      for (const [line, col, cell] of b) second.tracks[0].cells[line][col] = cell;
      p.patterns.push(second);
      p.order = ['pat_1', 'pat_2'];
    },
    8,
  );
}

const keyOns = (ir: IR) => ir.voices.flat().filter((e): e is KeyOnEvent => e.type === 'keyOn');
type VolumeEvent = Extract<VoiceEvent, { type: 'setVolume' }>;
const volumes = (lane: VoiceEvent[]) => lane.filter((e): e is VolumeEvent => e.type === 'setVolume');

describe('static track mix', () => {
  it('track volume multiplies into every note', () => {
    const k = keyOns(compileSong(one([[0, 0, { note: 60, volume: 0x40 }]], { volume: 64 })))[0];
    expect([k.volL, k.volR]).toEqual([V(0x40, 64), V(0x40, 64)]);
  });

  it('track pan adds to the note pan', () => {
    const right = keyOns(compileSong(one([[0, 0, { note: 60 }]], { pan: 32 })))[0];
    expect([right.volL, right.volR]).toEqual(Object.values(stereoVolume(V(127), 32)));
    const centred = keyOns(compileSong(one([[0, 0, { note: 60, pan: -32 }]], { pan: 32 })))[0];
    expect([centred.volL, centred.volR]).toEqual([V(127), V(127)]);
  });

  it('transpose shifts the note before the zone is chosen', () => {
    const p = one([[0, 0, { note: 60 }]], { transpose: 12 });
    p.samples.push({ ...p.samples[0], id: 'smp_high', rootNote: 72 });
    p.devices[0].zones = [
      { sampleId: TEST_SAMPLE_ID, keyRange: [0, 65], volume: 127, pan: 0 },
      { sampleId: 'smp_high', keyRange: [66, 127], volume: 127, pan: 0 },
    ];
    const k = keyOns(compileSong(p))[0];
    expect(k.note).toBe(72);
    expect(k.sampleSlot).toBe(1);
    expect(k.pitch).toBe(0x1000);
  });

  it('transpose applies to portamento targets too', () => {
    const lane = compileSong(one([[0, 0, { note: 60 }], [1, 0, { note: 62, ...fx('porta', 0xff) }]], { transpose: -12 })).voices[0];
    expect((lane[0] as KeyOnEvent).pitch).toBe(P(48));
    expect(lane.filter((e) => e.type === 'setPitch').pop()).toMatchObject({ pitch: P(50) });
  });

  it('device fine tune adds cents to the pitch', () => {
    const p = fixture([{ device: device('p', 'poly', { fineTune: 100 }), cells: [[0, 0, { note: 60 }]] }]);
    expect(keyOns(compileSong(p))[0].pitch).toBe(P(61));
    const down = fixture([{ device: device('p', 'poly', { fineTune: -50 }), cells: [[0, 0, { note: 60 }]] }]);
    expect(keyOns(compileSong(down))[0].pitch).toBe(Math.round(0x1000 * 2 ** (-0.5 / 12)));
  });

  it('device fine tune also applies to live play, which shares the processor', () => {
    const calls: number[] = [];
    class Dsp extends SDsp {
      keyOn(voice: number, k: KeyOnParams): void {
        calls.push(k.pitch);
        super.keyOn(voice, k);
      }
    }
    const live = new LivePlayer(new Dsp());
    live.setup(liveSetupFor(fixture([{ device: device('p', 'poly', { fineTune: 100 }), cells: [] }])));
    live.noteOn('p', 60, 100);
    live.render(new Float32Array(640), new Float32Array(640), 0, 640);
    expect(calls).toEqual([P(61)]);
  });
});

describe('panSlide L', () => {
  it('moves the note pan right by x and left by y per tick', () => {
    const lane = compileSong(one([[0, 0, { note: 60 }], [1, 0, fx('panSlide', 0x01)]])).voices[0];
    const last = volumes(lane).pop()!;
    expect([last.volL, last.volR]).toEqual(Object.values(stereoVolume(V(127), -6)));
    expect(last.auto).toBe(true);
    const right = volumes(compileSong(one([[0, 0, { note: 60 }], [1, 0, fx('panSlide', 0x20)]])).voices[0]).pop()!;
    expect([right.volL, right.volR]).toEqual(Object.values(stereoVolume(V(127), 12)));
  });

  it('stops at the far right', () => {
    const last = volumes(compileSong(one([[0, 0, { note: 60, pan: 60 }], [1, 0, fx('panSlide', 0xf0)]])).voices[0]).pop()!;
    expect([last.volL, last.volR]).toEqual([0, V(127)]);
  });
});

describe('track effects M, K, X', () => {
  it('M on a line without a note changes the sounding note, as a composer event', () => {
    const lane = compileSong(one([[0, 0, { note: 60 }], [2, 0, fx('trackVolume', 0x40)]])).voices[0];
    expect(volumes(lane)).toEqual([{ tick: 12, type: 'setVolume', volL: V(127, 64), volR: V(127, 64), source: expect.anything() }]);
  });

  it('M before a note sets the volume the note starts with, and persists over lines', () => {
    const k = keyOns(compileSong(one([[0, 0, fx('trackVolume', 0x40)], [5, 0, { note: 60 }]])))[0];
    expect([k.volL, k.volR]).toEqual([V(127, 64), V(127, 64)]);
  });

  it('M values above 7F mean full volume', () => {
    const lane = compileSong(one([[0, 0, { note: 60 }], [1, 0, fx('trackVolume', 0x20)], [2, 0, fx('trackVolume', 0xff)]])).voices[0];
    expect(volumes(lane).pop()).toMatchObject({ volL: V(127), volR: V(127) });
  });

  it('track effects affect every note of the track', () => {
    const ir = compileSong(one([[0, 0, { note: 60 }], [0, 1, { note: 64 }], [2, 2, fx('trackVolume', 0x20)]], {}, 3));
    expect(ir.voices.slice(0, 2).map((lane) => volumes(lane).map((e) => [e.tick, e.volL]))).toEqual([[[12, V(127, 0x20)]], [[12, V(127, 0x20)]]]);
  });

  it('K slides the track volume per tick, also without a note on the line', () => {
    const lane = compileSong(one([[0, 0, { note: 60 }], [1, 0, fx('trackVolSlide', 0x02)]])).voices[0];
    const vs = volumes(lane);
    expect(vs.map((e) => e.tick)).toEqual([6, 7, 8, 9, 10, 11]);
    expect(vs.pop()).toMatchObject({ volL: V(127, 127 - 12), auto: true });
  });

  it('K slides up and stops at 7F', () => {
    const lane = compileSong(one([[0, 0, { note: 60, ...fx('trackVolume', 0x7c) }], [1, 0, fx('trackVolSlide', 0x20)]])).voices[0];
    expect(volumes(lane).pop()).toMatchObject({ volL: V(127, 127) });
  });

  it('X sets the track pan, 40 = centre', () => {
    const lane = compileSong(one([[0, 0, { note: 60 }], [1, 0, fx('trackPan', 0x00)], [2, 0, fx('trackPan', 0x40)]])).voices[0];
    const vs = volumes(lane);
    expect(vs.map((e) => [e.tick, e.volL, e.volR, e.auto])).toEqual([
      [6, ...Object.values(stereoVolume(V(127), -64)), undefined],
      [12, V(127), V(127), undefined],
    ]);
  });

  it('M, K and X state resets to the next pattern’s own track settings', () => {
    // Pattern 1 fades its note with M; the note rings into pattern 2, whose header says 7F.
    const ir = compileSong(two([[0, 0, { note: 60 }], [2, 0, fx('trackVolume', 0x20)], [3, 0, fx('trackPan', 0x00)]], [[4, 0, { note: 62 }]]));
    const lane = ir.voices[0];
    expect(volumes(lane).map((e) => [e.tick, e.volL, e.volR])).toEqual([
      [12, V(127, 0x20), V(127, 0x20)],
      [18, V(127, 0x20), 0],
      [48, V(127), V(127)],
    ]);
    const second = keyOns(ir)[1];
    expect([second.volL, second.volR]).toEqual([V(127), V(127)]);
  });

  it('a pattern sounds the same in the song as played alone', () => {
    const p = two([[0, 0, fx('trackVolume', 0x10)]], [[0, 0, { note: 60 }]], {}, { volume: 90, pan: -10 });
    const inSong = keyOns(compileSong(p))[0];
    const alone = keyOns(compileSong(p, { order: ['pat_2'] }))[0];
    expect([inSong.volL, inSong.volR]).toEqual([alone.volL, alone.volR]);
    expect([alone.volL, alone.volR]).toEqual(Object.values(stereoVolume(V(127, 90), -10)));
  });

  it('a static track volume change at a pattern boundary updates a ringing note', () => {
    const lane = compileSong(two([[0, 0, { note: 60 }]], [], {}, { volume: 64 })).voices[0];
    expect(volumes(lane)).toEqual([{ tick: 48, type: 'setVolume', volL: V(127, 64), volR: V(127, 64), source: expect.anything() }]);
  });
});

describe('effects working together', () => {
  it('a pitch slide and a volume slide in one cell both apply every tick', () => {
    const lane = compileSong(one([[0, 0, { note: 60 }], [1, 0, { fx: [{ type: 'slideUp', value: 0x10 }, { type: 'volSlide', value: 0x02 }] }]])).voices[0];
    expect(lane.filter((e) => e.type === 'setPitch').pop()).toMatchObject({ pitch: P(61) });
    expect(volumes(lane).pop()).toMatchObject({ volL: V(127 - 12) });
  });

  it('note volume slide and track volume slide multiply', () => {
    const lane = compileSong(one([[0, 0, { note: 60 }], [1, 0, { fx: [{ type: 'volSlide', value: 0x02 }, { type: 'trackVolSlide', value: 0x04 }] }]])).voices[0];
    expect(volumes(lane).pop()).toMatchObject({ volL: V(127 - 12, 127 - 24) });
  });

  it('pan slide and track pan add up', () => {
    const lane = compileSong(one([[0, 0, { note: 60 }], [1, 0, { fx: [{ type: 'trackPan', value: 0x50 }, { type: 'panSlide', value: 0x01 }] }]])).voices[0];
    const last = volumes(lane).pop()!;
    expect([last.volL, last.volR]).toEqual(Object.values(stereoVolume(V(127), 16 - 6)));
  });
});
