import { describe, expect, it } from 'vitest';
import { newPattern, newTrack } from '../model/defaults';
import type { Cell, Effect, EffectType, Project } from '../model/types';
import { compileSong } from './compile';
import { device, fixture } from './fixtures';
import { FxMemory } from './fxMemory';
import type { VoiceEvent } from './ir';

type CellSpec = [number, number, Cell];

/** A poly track over two 8-line patterns played in order; `b` holds the second pattern's cells. */
function song(a: CellSpec[], b: CellSpec[] = [], columns = 1): Project {
  return fixture(
    [{ device: device('p', 'poly', { maxVoices: 8 }), columns, cells: a }],
    (p) => {
      const second = newPattern('Q', 8, [newTrack('p', columns, 8)], 'pat_2');
      for (const [line, col, cell] of b) second.tracks[0].cells[line][col] = cell;
      p.patterns.push(second);
      p.order = ['pat_1', 'pat_2'];
    },
    8,
  );
}

/** Voice events without their source, so cells on different lines can be compared. */
function events(p: Project): Omit<VoiceEvent, 'source'>[][] {
  return compileSong(p).voices.map((lane) => lane.map(({ source: _s, ...rest }) => rest));
}

const fx = (type: EffectType, value: number): { fx: Effect[] } => ({ fx: [{ type, value }] });

describe('effect memory resolves 00 to the last non-zero value', () => {
  // Each case: an effect written with a value, then continued with 00 on the next lines. The 00
  // version must compile exactly like writing the value out, and differently from no effect.
  const cases: { type: EffectType; value: number; start: Cell; target?: Cell }[] = [
    { type: 'slideUp', value: 0x10, start: { note: 60 } },
    { type: 'slideDown', value: 0x08, start: { note: 60 } },
    { type: 'porta', value: 0x10, start: { note: 60 }, target: { note: 72 } },
    { type: 'vibrato', value: 0x46, start: { note: 60 } },
    { type: 'volSlide', value: 0x03, start: { note: 60 } },
    { type: 'panSlide', value: 0x20, start: { note: 60 } },
    { type: 'retrig', value: 0x02, start: { note: 60 } },
    { type: 'trackVolSlide', value: 0x02, start: { note: 60 } },
  ];

  for (const c of cases) {
    it(`${c.type}: within a pattern`, () => {
      const first: Cell = { ...(c.target ?? {}), ...fx(c.type, c.value) };
      const remembered = song([[0, 0, c.start], [1, 0, first], [2, 0, fx(c.type, 0)], [3, 0, fx(c.type, 0)]]);
      const written = song([[0, 0, c.start], [1, 0, first], [2, 0, fx(c.type, c.value)], [3, 0, fx(c.type, c.value)]]);
      const absent = song([[0, 0, c.start], [1, 0, first]]);
      expect(events(remembered)).toEqual(events(written));
      expect(events(remembered)).not.toEqual(events(absent));
    });

    it(`${c.type}: across patterns in song order`, () => {
      const first: Cell = { ...(c.target ?? {}), ...fx(c.type, c.value) };
      const remembered = song([[0, 0, c.start], [7, 0, first]], [[0, 0, fx(c.type, 0)]]);
      const written = song([[0, 0, c.start], [7, 0, first]], [[0, 0, fx(c.type, c.value)]]);
      expect(events(remembered)).toEqual(events(written));
    });
  }

  it('00 without an earlier value stays 00 (existing behaviour)', () => {
    const zero = song([[0, 0, { note: 60 }], [1, 0, fx('slideUp', 0)]]);
    const none = song([[0, 0, { note: 60 }]]);
    expect(events(zero)).toEqual(events(none));
  });

  it('vibrato remembers depth and speed separately', () => {
    const base: CellSpec[] = [[0, 0, { note: 60 }], [1, 0, fx('vibrato', 0x23)]];
    const cmp = (written: number, meant: number) =>
      expect(events(song([...base, [2, 0, fx('vibrato', written)]]))).toEqual(events(song([...base, [2, 0, fx('vibrato', meant)]])));
    cmp(0x05, 0x25); // x = 0 keeps the depth
    cmp(0x40, 0x43); // y = 0 keeps the speed
    cmp(0x00, 0x23);
  });

  it('memory is kept per note column', () => {
    const cells: CellSpec[] = [[0, 0, { note: 60 }], [0, 1, { note: 64 }], [1, 0, fx('slideUp', 0x10)], [2, 1, fx('slideUp', 0)]];
    const without: CellSpec[] = [[0, 0, { note: 60 }], [0, 1, { note: 64 }], [1, 0, fx('slideUp', 0x10)]];
    expect(events(song(cells, [], 2))).toEqual(events(song(without, [], 2)));
  });

  it('effects without memory keep 00 as a value', () => {
    // C00 cuts on the line's first tick even after a C03.
    const ir = compileSong(song([[0, 0, { note: 60, ...fx('cut', 3) }], [1, 0, { note: 62 }], [2, 0, fx('cut', 0)]]));
    expect(ir.voices[0].filter((e) => e.type === 'keyOff').map((e) => e.tick)).toEqual([3, 12]);
  });

  it('two remembered slides in one cell continue together', () => {
    const remembered = song([[0, 0, { note: 60 }], [1, 0, { fx: [{ type: 'slideUp', value: 0x10 }, { type: 'volSlide', value: 0x02 }] }], [2, 0, { fx: [{ type: 'slideUp', value: 0 }, { type: 'volSlide', value: 0 }] }]]);
    const written = song([[0, 0, { note: 60 }], [1, 0, { fx: [{ type: 'slideUp', value: 0x10 }, { type: 'volSlide', value: 0x02 }] }], [2, 0, { fx: [{ type: 'slideUp', value: 0x10 }, { type: 'volSlide', value: 0x02 }] }]]);
    expect(events(remembered)).toEqual(events(written));
  });
});

describe('FxMemory', () => {
  const resolve = (m: FxMemory, column: number, type: EffectType, value: number) => m.resolve(column, [{ type, value }])[0].value;

  it('covers every memory effect, including the global and tremolo ones other code applies', () => {
    const m = new FxMemory();
    for (const type of ['mainVolSlide', 'echoVolSlide', 'trackVolSlide', 'retrig'] as EffectType[]) {
      expect(resolve(m, 0, type, 0)).toBe(0);
      expect(resolve(m, 0, type, 0x21)).toBe(0x21);
      expect(resolve(m, 0, type, 0)).toBe(0x21);
    }
    expect(resolve(m, 0, 'tremolo', 0x34)).toBe(0x34);
    expect(resolve(m, 0, 'tremolo', 0x06)).toBe(0x36);
    expect(resolve(m, 0, 'tremolo', 0x50)).toBe(0x56);
    expect(resolve(m, 0, 'tremolo', 0)).toBe(0x56);
  });

  it('keeps types apart and leaves other effects alone', () => {
    const m = new FxMemory();
    resolve(m, 0, 'slideUp', 0x10);
    expect(resolve(m, 0, 'slideDown', 0)).toBe(0);
    expect(resolve(m, 1, 'slideUp', 0)).toBe(0);
    expect(resolve(m, 0, 'trackVolume', 0)).toBe(0);
  });

  it('never mutates the effects it is given', () => {
    const m = new FxMemory();
    resolve(m, 0, 'slideUp', 0x10);
    const input = [{ type: 'slideUp' as const, value: 0 }];
    expect(m.resolve(0, input)[0].value).toBe(0x10);
    expect(input[0].value).toBe(0);
  });
});
