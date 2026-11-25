import { describe, expect, it } from 'vitest';
import { emptyProject, newPattern, newTrack } from '../model/defaults';
import type { LineComment, Pattern, Project } from '../model/types';
import {
  addComment,
  chordInForce,
  chordMarkerAt,
  clonePattern,
  commentsAfterLineDelete,
  commentsAfterLineInsert,
  commentsAfterTrackDelete,
  commentsAt,
  commentsInSongOrder,
  dropAnnotationsPast,
  editComment,
  noteHarmony,
  removeChordMarker,
  removeComment,
  setChordMarker,
} from './harmonyEdit';

function pattern(id: string, lines = 16): Pattern {
  return newPattern(id, lines, [newTrack(null, 1, lines), newTrack(null, 1, lines), newTrack(null, 1, lines)], id);
}

const cmt = (id: string, line: number, track: number | null, text = id): LineComment => ({ id, line, track, text });

describe('chord markers', () => {
  it('adds markers sorted by line and replaces the one at the same line', () => {
    let p = pattern('a');
    p = setChordMarker(p, 8, 'D/E');
    p = setChordMarker(p, 0, 'Em');
    p = setChordMarker(p, 4, 'C');
    expect(p.chords.map((m) => m.line)).toEqual([0, 4, 8]);
    p = setChordMarker(p, 4, ' Cmaj7 ');
    expect(p.chords).toEqual([
      { line: 0, symbol: 'Em' },
      { line: 4, symbol: 'Cmaj7' },
      { line: 8, symbol: 'D/E' },
    ]);
  });

  it('keeps symbols it cannot parse, so they can be fixed later', () => {
    const p = setChordMarker(pattern('a'), 2, 'Hm7?');
    expect(chordMarkerAt(p, 2)?.symbol).toBe('Hm7?');
  });

  it('removes a marker by line or by an empty symbol', () => {
    let p = setChordMarker(setChordMarker(pattern('a'), 0, 'Em'), 8, 'C');
    p = removeChordMarker(p, 0);
    expect(p.chords).toEqual([{ line: 8, symbol: 'C' }]);
    p = setChordMarker(p, 8, '  ');
    expect(p.chords).toEqual([]);
    const unchanged = removeChordMarker(p, 3);
    expect(unchanged).toBe(p);
  });

  it('finds the marker in force, also carried over from earlier patterns in song order', () => {
    const a = setChordMarker(setChordMarker(pattern('a'), 0, 'Em'), 8, 'D/E');
    const b = setChordMarker(pattern('b'), 4, 'C');
    const c = pattern('c');
    const p: Project = { ...emptyProject(), patterns: [a, b, c], order: ['a', 'b', 'c'] };
    expect(chordInForce(p, a, 0, 7)?.symbol).toBe('Em');
    expect(chordInForce(p, a, 0, 8)?.symbol).toBe('D/E');
    expect(chordInForce(p, b, 1, 0)?.symbol).toBe('D/E');
    expect(chordInForce(p, b, 1, -1)?.symbol).toBe('D/E');
    expect(chordInForce(p, b, 1, 4)?.symbol).toBe('C');
    expect(chordInForce(p, c, 2, 15)?.symbol).toBe('C');
    // Outside the song a pattern only sees its own markers.
    expect(chordInForce(p, b, -1, 0)).toBeNull();
  });
});

describe('comments', () => {
  it('adds comments sorted by line and track, line comments first', () => {
    let p = pattern('a');
    p = addComment(p, cmt('c1', 4, 2));
    p = addComment(p, cmt('c2', 4, null));
    p = addComment(p, cmt('c3', 1, 0));
    p = addComment(p, cmt('c4', 4, 0));
    expect(p.comments.map((c) => c.id)).toEqual(['c3', 'c2', 'c4', 'c1']);
    expect(commentsAt(p, 4, null).map((c) => c.id)).toEqual(['c2']);
    expect(commentsAt(p, 4, 2).map((c) => c.id)).toEqual(['c1']);
  });

  it('ignores an empty comment, edits text and deletes on empty text', () => {
    let p = addComment(pattern('a'), cmt('c1', 0, 0, ' sounds off '));
    expect(addComment(p, cmt('c2', 1, 0, '   '))).toBe(p);
    expect(p.comments[0].text).toBe('sounds off');
    p = editComment(p, 'c1', 'too loud');
    expect(p.comments[0].text).toBe('too loud');
    p = editComment(p, 'c1', '');
    expect(p.comments).toEqual([]);
  });

  it('removes a comment by ID', () => {
    let p = addComment(addComment(pattern('a'), cmt('c1', 0, 0)), cmt('c2', 1, null));
    p = removeComment(p, 'c1');
    expect(p.comments.map((c) => c.id)).toEqual(['c2']);
  });

  it('lists comments in song order, each pattern once, patterns outside the song last', () => {
    const a = addComment(addComment(pattern('a'), cmt('a8', 8, 1)), cmt('a2', 2, null));
    const b = addComment(pattern('b'), cmt('b0', 0, 0));
    const x = addComment(pattern('x'), cmt('x5', 5, 2));
    const p: Project = { ...emptyProject(), patterns: [x, a, b], order: ['b', 'a', 'b'] };
    expect(commentsInSongOrder(p).map((e) => [e.comment.id, e.orderIndex])).toEqual([
      ['b0', 0],
      ['a2', 1],
      ['a8', 1],
      ['x5', -1],
    ]);
  });
});

describe('line and track operations', () => {
  const withAnnotations = () => {
    let p = setChordMarker(setChordMarker(pattern('a', 8), 2, 'Em'), 6, 'C');
    for (const c of [cmt('t1l1', 1, 1), cmt('t1l3', 3, 1), cmt('t1l7', 7, 1), cmt('t0l3', 3, 0), cmt('line3', 3, null)]) p = addComment(p, c);
    return p;
  };
  const lines = (p: Pattern) => Object.fromEntries(p.comments.map((c) => [c.id, c.line]));

  it('inserting a line in a track moves only that track comments and drops those pushed out', () => {
    const p = commentsAfterLineInsert(withAnnotations(), 1, 3);
    expect(lines(p)).toEqual({ t1l1: 1, t1l3: 4, t0l3: 3, line3: 3 });
    expect(p.chords).toEqual(withAnnotations().chords);
  });

  it('deleting a line in a track removes its comment there and pulls later ones up', () => {
    const p = commentsAfterLineDelete(withAnnotations(), 1, 1);
    expect(lines(p)).toEqual({ t1l3: 2, t1l7: 6, t0l3: 3, line3: 3 });
    expect(p.chords).toEqual(withAnnotations().chords);
  });

  it('a line operation on a track without comments returns the pattern unchanged', () => {
    const p = withAnnotations();
    expect(commentsAfterLineInsert(p, 2, 0)).toBe(p);
  });

  it('shrinking the pattern drops markers and comments past the end', () => {
    const p = dropAnnotationsPast(withAnnotations(), 4);
    expect(p.chords).toEqual([{ line: 2, symbol: 'Em' }]);
    expect(Object.keys(lines(p)).sort()).toEqual(['line3', 't0l3', 't1l1', 't1l3']);
  });

  it('deleting a track drops its comments and renumbers later tracks', () => {
    const p = commentsAfterTrackDelete(withAnnotations(), 0);
    expect(p.comments.map((c) => [c.id, c.track])).toEqual([
      ['t1l1', 0],
      ['line3', null],
      ['t1l3', 0],
      ['t1l7', 0],
    ]);
  });

  it('cloning copies key, markers and comments, with fresh comment IDs', () => {
    const src = { ...withAnnotations(), key: { root: 9, mode: 'dorian' as const } };
    let n = 0;
    const copy = clonePattern(src, 'b', 'a copy', () => `new${n++}`);
    expect(copy.id).toBe('b');
    expect(copy.name).toBe('a copy');
    expect(copy.key).toEqual(src.key);
    expect(copy.chords).toEqual(src.chords);
    expect(copy.comments.map((c) => c.id)).toEqual(['new0', 'new1', 'new2', 'new3', 'new4']);
    expect(copy.comments.map((c) => c.text)).toEqual(src.comments.map((c) => c.text));
    copy.chords[0].symbol = 'X';
    expect(src.chords[0].symbol).toBe('Em');
  });
});

describe('note relations', () => {
  const eDorian = { root: 4, mode: 'dorian' as const };

  it('gives the scale degree and the chord relation', () => {
    const g = noteHarmony(67, eDorian, { line: 0, symbol: 'Em' });
    expect(g.degree).toBe('3');
    expect(g.inKey).toBe(true);
    expect(g.chord).toEqual({ symbol: 'Em', valid: true, chordTone: true, interval: 'b3' });
    const a = noteHarmony(69, eDorian, { line: 0, symbol: 'Em' });
    expect(a.chord).toEqual({ symbol: 'Em', valid: true, chordTone: false, interval: '4' });
  });

  it('marks notes outside the key, and works without key or chord', () => {
    expect(noteHarmony(72, eDorian, null)).toEqual({ degree: 'b6', inKey: false, chord: null });
    expect(noteHarmony(60, null, null)).toEqual({ degree: null, inKey: false, chord: null });
  });

  it('reports a chord symbol it cannot parse', () => {
    expect(noteHarmony(60, null, { line: 0, symbol: 'Hm' }).chord).toEqual({ symbol: 'Hm', valid: false });
  });

  it('counts the slash bass as a chord tone', () => {
    expect(noteHarmony(64, null, { line: 0, symbol: 'D/E' }).chord).toMatchObject({ chordTone: true, interval: '2' });
  });
});
