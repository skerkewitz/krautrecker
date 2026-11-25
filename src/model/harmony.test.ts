import { describe, expect, it } from 'vitest';
import { emptyProject, newPattern } from './defaults';
import { chordsBySongLine, keyName, parseChord, scaleDegree, scalePitchClasses } from './harmony';

const pcs = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe('keys and scales', () => {
  it('E dorian has the notes E F# G A B C# D', () => {
    expect(pcs(scalePitchClasses({ root: 4, mode: 'dorian' }))).toEqual([1, 2, 4, 6, 7, 9, 11]);
    expect(keyName({ root: 4, mode: 'dorian' })).toBe('E dorian');
  });

  it('names scale degrees, with accidentals for notes outside the scale', () => {
    const e = { root: 4, mode: 'dorian' as const };
    expect(scaleDegree(64, e)).toBe('1'); // E
    expect(scaleDegree(67, e)).toBe('3'); // G is the (minor) third degree of dorian
    expect(scaleDegree(73, e)).toBe('6'); // C#
    expect(scaleDegree(72, e)).toBe('b6'); // C is outside E dorian
    expect(scaleDegree(70, e)).toBe('#4'); // A#
  });
});

describe('chord symbols', () => {
  it('parses triads, sevenths, suspensions and slash chords', () => {
    expect(pcs(parseChord('Em')!.tones)).toEqual([4, 7, 11]);
    expect(pcs(parseChord('Cmaj7')!.tones)).toEqual([0, 4, 7, 11]);
    expect(pcs(parseChord('Bbsus4')!.tones)).toEqual([3, 5, 10]);
    expect(pcs(parseChord('F#m7b5')!.tones)).toEqual([0, 4, 6, 9]);
    const de = parseChord('D/E')!;
    expect(de.root).toBe(2);
    expect(de.bass).toBe(4);
    expect(pcs(de.tones)).toEqual([2, 4, 6, 9]);
  });

  it('rejects text that is not a chord', () => {
    expect(parseChord('hello')).toBeNull();
    expect(parseChord('Cxyz')).toBeNull();
    expect(parseChord('C/H')).toBeNull();
  });
});

describe('chord markers along the song', () => {
  it('hold until the next marker, also across pattern boundaries', () => {
    const p = emptyProject();
    const a = newPattern('A', 4, [], 'a');
    const b = newPattern('B', 4, [], 'b');
    a.chords = [{ line: 2, symbol: 'Am' }];
    b.chords = [{ line: 1, symbol: 'G' }];
    p.patterns = [a, b];
    p.order = ['a', 'b'];
    expect(chordsBySongLine(p).map((c) => c?.symbol ?? '-')).toEqual(['-', '-', 'Am', 'Am', 'Am', 'G', 'G', 'G']);
  });
});
