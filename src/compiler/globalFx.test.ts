import { describe, expect, it } from 'vitest';
import { newPattern, newTrack } from '../model/defaults';
import type { Cell, EffectType, Project } from '../model/types';
import { compileSong } from './compile';
import { device, fixture } from './fixtures';
import type { GlobalEvent, IR } from './ir';

// Fixture timing: 125 BPM, 4 LPB, 6 ticks per line. Hardware: main volume 100/100, echo off.

const fx = (type: EffectType, value: number, extra: Cell = {}): Cell => ({ ...extra, fx: [{ type, value }] });

/** Global events caused by effects: everything after the initial tempo, echo and main volume. */
function effectEvents(ir: IR): GlobalEvent[] {
  return ir.global.slice(3);
}

function ofType<T extends GlobalEvent['type']>(ir: IR, type: T): Extract<GlobalEvent, { type: T }>[] {
  return effectEvents(ir).filter((e): e is Extract<GlobalEvent, { type: T }> => e.type === type);
}

/** A song of patterns, one track each, playing the same poly device. */
function song(patterns: { lines: number; cells: [number, Cell][] }[], patch: (p: Project) => void = () => {}): Project {
  const d = device('pad', 'poly');
  return fixture([{ device: d, cells: [] }], (p) => {
    p.patterns = patterns.map((spec, i) => {
      const pat = newPattern(`P${i}`, spec.lines, [newTrack(d.id, 1, spec.lines)], `pat_${i}`);
      for (const [line, cell] of spec.cells) pat.tracks[0].cells[line][0] = cell;
      return pat;
    });
    p.order = p.patterns.map((x) => x.id);
    patch(p);
  });
}

describe('song loop point', () => {
  const three = (loopOrderIndex: number) => song([{ lines: 16, cells: [] }, { lines: 8, cells: [] }, { lines: 4, cells: [] }], (p) => (p.loopOrderIndex = loopOrderIndex));

  it('loop point 0 loops the whole song', () => {
    expect(compileSong(three(0)).loopTick).toBe(0);
  });

  it('loopTick is the first tick of the loop order entry', () => {
    expect(compileSong(three(1)).loopTick).toBe(16 * 6);
    expect(compileSong(three(2)).loopTick).toBe(24 * 6);
  });

  it('clamps invalid loop points into the order list', () => {
    expect(compileSong(three(-3)).loopTick).toBe(0);
    expect(compileSong(three(99)).loopTick).toBe(24 * 6);
    expect(compileSong(three(Number.NaN)).loopTick).toBe(0);
  });

  it('skips an order entry whose pattern is missing', () => {
    const p = three(1);
    p.order[1] = 'pat_missing';
    expect(compileSong(p).loopTick).toBe(16 * 6);
  });

  it('a single compiled pattern (pattern play) always loops from its start', () => {
    const p = three(1);
    expect(compileSong(p, { order: ['pat_1'] }).loopTick).toBe(0);
  });
});

describe('global effects', () => {
  it('without global effects, the global lane holds only the initial state', () => {
    const ir = compileSong(song([{ lines: 8, cells: [[0, { note: 60 }]] }]));
    expect(ir.global.map((e) => e.type)).toEqual(['tempo', 'echo', 'mainVolume']);
  });

  it('tempo F sets the BPM from its line on; values below 20 clamp to 32 BPM', () => {
    const ir = compileSong(song([{ lines: 8, cells: [[2, fx('tempo', 0x96)], [5, fx('tempo', 0x10)]] }]));
    expect(ofType(ir, 'tempo')).toEqual([
      { tick: 12, type: 'tempo', bpm: 150 },
      { tick: 30, type: 'tempo', bpm: 32 },
    ]);
    // The IR stays tick-based: its timing keeps the song's base tempo.
    expect(ir.timing.bpm).toBe(125);
  });

  it('mainVolume W sets both sides; mainVolSlide H moves them on every tick of its line', () => {
    const ir = compileSong(song([{ lines: 8, cells: [[1, fx('mainVolume', 0x40)], [3, fx('mainVolSlide', 0x02)]] }]));
    const ev = ofType(ir, 'mainVolume');
    expect(ev[0]).toEqual({ tick: 6, type: 'mainVolume', volL: 0x40, volR: 0x40 });
    // Line 3 = ticks 18..23, down 2 per tick from 64.
    expect(ev.slice(1).map((e) => [e.tick, e.volL, e.volR, e.auto ?? false])).toEqual([
      [18, 62, 62, false],
      [19, 60, 60, true],
      [20, 58, 58, true],
      [21, 56, 56, true],
      [22, 54, 54, true],
      [23, 52, 52, true],
    ]);
  });

  it('volume effects keep a phase-inverted (negative) side inverted', () => {
    const ir = compileSong(song([{ lines: 4, cells: [[0, fx('mainVolume', 0x30)], [1, fx('mainVolSlide', 0x10)]] }], (p) => (p.hardware.mainVolumeR = -100)));
    const ev = ofType(ir, 'mainVolume');
    expect(ev[0]).toMatchObject({ volL: 0x30, volR: -0x30 });
    expect(ev[ev.length - 1]).toMatchObject({ volL: 0x30 + 6, volR: -(0x30 + 6) });
  });

  it('slides clamp at 0 and 127', () => {
    const ir = compileSong(song([{ lines: 4, cells: [[0, fx('mainVolSlide', 0x0f)], [1, fx('mainVolSlide', 0x0f)], [2, fx('mainVolSlide', 0xf0)]] }]));
    const ev = ofType(ir, 'mainVolume');
    expect(Math.min(...ev.map((e) => e.volL))).toBe(0);
    expect(ev[ev.length - 1].volL).toBe(90);
    const up = compileSong(song([{ lines: 4, cells: [[0, fx('mainVolSlide', 0xf0)]] }]));
    expect(ofType(up, 'mainVolume').map((e) => e.volL)).toEqual([115, 127]);
  });

  it('echo effects E, Y and B emit full echo parameters', () => {
    const ir = compileSong(
      song([{ lines: 8, cells: [[0, fx('echoVolume', 0x50)], [1, fx('echoFeedback', 0xc0)], [2, fx('echoVolSlide', 0x10)]] }], (p) => {
        p.hardware.echo = { delay: 3, feedback: 20, volumeL: 10, volumeR: 12, fir: [100, 10, 5, 0, 0, 0, 0, 12], writeEnabled: true };
      }),
    );
    const ev = ofType(ir, 'echo');
    const fir = [100, 10, 5, 0, 0, 0, 0, 12];
    expect(ev[0]).toEqual({ tick: 0, type: 'echo', params: { delay: 3, feedback: 20, volumeL: 0x50, volumeR: 0x50, fir } });
    expect(ev[1]).toEqual({ tick: 6, type: 'echo', params: { delay: 3, feedback: -64, volumeL: 0x50, volumeR: 0x50, fir } });
    expect(ev.slice(2).map((e) => [e.tick, e.params.volumeL, e.params.feedback, e.auto ?? false])).toEqual([
      [12, 0x51, -64, false],
      [13, 0x52, -64, true],
      [14, 0x53, -64, true],
      [15, 0x54, -64, true],
      [16, 0x55, -64, true],
      [17, 0x56, -64, true],
    ]);
  });

  it('echoWrite Z: 00 freezes the buffer, any other value enables writes', () => {
    const ir = compileSong(song([{ lines: 8, cells: [[1, fx('echoWrite', 0)], [2, fx('echoWrite', 0)], [4, fx('echoWrite', 1)]] }]));
    expect(ofType(ir, 'echoWrite')).toEqual([
      { tick: 6, type: 'echoWrite', enabled: false },
      { tick: 24, type: 'echoWrite', enabled: true },
    ]);
  });

  it('starts from the hardware settings, including frozen echo writes', () => {
    const ir = compileSong(song([{ lines: 4, cells: [[1, fx('echoWrite', 1)]] }], (p) => (p.hardware.echo.writeEnabled = false)));
    expect(ir.global.filter((e) => e.type === 'echoWrite')).toEqual([
      { tick: 0, type: 'echoWrite', enabled: false },
      { tick: 6, type: 'echoWrite', enabled: true },
    ]);
  });

  it('persists across patterns: a slide continues from a value set in an earlier pattern', () => {
    const ir = compileSong(song([{ lines: 4, cells: [[0, fx('mainVolume', 0x20)]] }, { lines: 4, cells: [[2, fx('mainVolSlide', 0x10)]] }]));
    const ev = ofType(ir, 'mainVolume');
    expect(ev[0]).toMatchObject({ tick: 0, volL: 0x20 });
    expect(ev[1]).toMatchObject({ tick: 24 + 12, volL: 0x21 });
    expect(ev).toHaveLength(7);
  });

  it('acts on lines without notes and on tracks without a device', () => {
    const p = song([{ lines: 8, cells: [[0, { note: 60 }], [1, { note: 'OFF' }], [6, fx('tempo', 0xa0)]] }]);
    const quiet = newTrack(null, 1, 8);
    quiet.cells[3][0] = fx('mainVolume', 0x11);
    p.patterns[0].tracks.push(quiet);
    const ir = compileSong(p);
    expect(ofType(ir, 'tempo')).toEqual([{ tick: 36, type: 'tempo', bpm: 160 }]);
    expect(ofType(ir, 'mainVolume')).toEqual([{ tick: 18, type: 'mainVolume', volL: 0x11, volR: 0x11 }]);
  });

  it('reads every effect column, alongside note effects', () => {
    const cell: Cell = { note: 60, fx: [{ type: 'volSlide', value: 0x01 }, { type: 'tempo', value: 0x80 }] };
    const ir = compileSong(song([{ lines: 4, cells: [[1, cell]] }]));
    expect(ofType(ir, 'tempo')).toEqual([{ tick: 6, type: 'tempo', bpm: 128 }]);
  });

  it('on the same tick, the later track wins', () => {
    const p = song([{ lines: 4, cells: [[1, fx('tempo', 0x90)]] }]);
    const second = newTrack(null, 1, 4);
    second.cells[1][0] = fx('tempo', 0xb0);
    p.patterns[0].tracks.push(second);
    expect(ofType(compileSong(p), 'tempo')).toEqual([{ tick: 6, type: 'tempo', bpm: 176 }]);
  });

  it('a set followed by a slide in the next effect column applies both, in column order', () => {
    const cell: Cell = { fx: [{ type: 'mainVolume', value: 0x40 }, { type: 'mainVolSlide', value: 0x10 }] };
    const ev = ofType(compileSong(song([{ lines: 2, cells: [[0, cell]] }])), 'mainVolume');
    expect(ev.map((e) => e.volL)).toEqual([0x41, 0x42, 0x43, 0x44, 0x45, 0x46]);
    expect(ev[0].auto).toBeUndefined();
  });

  it('counts a slide as one song event in the ARAM estimate, not one per tick', () => {
    const base = compileSong(song([{ lines: 4, cells: [] }]));
    const slid = compileSong(song([{ lines: 4, cells: [[1, fx('mainVolSlide', 0x01)]] }]));
    const set = compileSong(song([{ lines: 4, cells: [[1, fx('mainVolume', 0x10)], [2, fx('tempo', 0x90)]] }]));
    expect(slid.aram.song - base.aram.song).toBe(3);
    expect(set.aram.song - base.aram.song).toBe(6);
  });

  it('is deterministic', () => {
    const make = () => song([{ lines: 8, cells: [[0, fx('mainVolSlide', 0x12)], [2, fx('echoVolSlide', 0x30)], [3, fx('tempo', 0x70)]] }]);
    expect(JSON.stringify(compileSong(make()).global)).toBe(JSON.stringify(compileSong(make()).global));
  });
});
