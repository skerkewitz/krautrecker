import { MODES, parseChord, scaleDegree, type Chord } from '../model/harmony';
import type { ChordMarker, LineComment, Mode, MusicalKey, Pattern, Project } from '../model/types';

/**
 * Pure edit operations for the harmonic intent (keys, chord markers) and line comments of a
 * pattern. None of this reaches the compiler: markers and comments never change the sound.
 */

export const MODE_NAMES = Object.keys(MODES) as Mode[];

// ------------------------------------------------------------------ keys

export function setSongKey(p: Project, key: MusicalKey | null): Project {
  return { ...p, key };
}

export function setPatternKey(pat: Pattern, key: MusicalKey | null): Pattern {
  return { ...pat, key };
}

// ------------------------------------------------------------------ chord markers

function byLine(a: ChordMarker, b: ChordMarker): number {
  return a.line - b.line;
}

/** The marker written at exactly this line, if any. */
export function chordMarkerAt(pat: Pattern, line: number): ChordMarker | null {
  return pat.chords.find((m) => m.line === line) ?? null;
}

/**
 * Sets the marker at a line (adds or replaces it); an empty symbol removes it. Symbols that
 * `parseChord` does not understand are kept as typed, so the composer can fix them later.
 */
export function setChordMarker(pat: Pattern, line: number, symbol: string): Pattern {
  const text = symbol.trim();
  if (text && chordMarkerAt(pat, line)?.symbol === text) return pat;
  const rest = pat.chords.filter((m) => m.line !== line);
  if (!text) return rest.length === pat.chords.length ? pat : { ...pat, chords: rest };
  return { ...pat, chords: [...rest, { line, symbol: text }].sort(byLine) };
}

export function removeChordMarker(pat: Pattern, line: number): Pattern {
  return setChordMarker(pat, line, '');
}

/**
 * The marker in force at a line of a pattern at an order position: the last marker at or before
 * the line, else the last marker of an earlier pattern in song order (markers hold across pattern
 * boundaries, as in `chordsBySongLine`). A pattern outside the song only sees its own markers.
 * Line -1 asks for the marker carried into the pattern.
 */
export function chordInForce(p: Project, pat: Pattern, orderIndex: number, line: number): ChordMarker | null {
  const own = lastMarker(pat, line);
  if (own) return own;
  if (orderIndex < 0 || p.order[orderIndex] !== pat.id) return null;
  const patterns = new Map(p.patterns.map((x) => [x.id, x]));
  for (let i = orderIndex - 1; i >= 0; i--) {
    const prev = patterns.get(p.order[i]);
    const m = prev && lastMarker(prev, prev.lines - 1);
    if (m) return m;
  }
  return null;
}

function lastMarker(pat: Pattern, line: number): ChordMarker | null {
  let found: ChordMarker | null = null;
  for (const m of pat.chords) if (m.line <= line && m.line < pat.lines && (!found || m.line >= found.line)) found = m;
  return found;
}

// ------------------------------------------------------------------ comments

function byPosition(a: LineComment, b: LineComment): number {
  return a.line - b.line || (a.track ?? -1) - (b.track ?? -1);
}

/** Comments at a position; `track` null means comments on the whole line. */
export function commentsAt(pat: Pattern, line: number, track: number | null): LineComment[] {
  return pat.comments.filter((c) => c.line === line && c.track === track);
}

/** Adds a comment, keeping the list sorted by line and track. Empty text adds nothing. */
export function addComment(pat: Pattern, comment: LineComment): Pattern {
  const text = comment.text.trim();
  if (!text) return pat;
  return { ...pat, comments: [...pat.comments, { ...comment, text }].sort(byPosition) };
}

/** Changes a comment's text; empty text deletes it. */
export function editComment(pat: Pattern, id: string, text: string): Pattern {
  const t = text.trim();
  if (!t) return removeComment(pat, id);
  if (!pat.comments.some((c) => c.id === id && c.text !== t)) return pat;
  return { ...pat, comments: pat.comments.map((c) => (c.id === id ? { ...c, text: t } : c)) };
}

export function removeComment(pat: Pattern, id: string): Pattern {
  const comments = pat.comments.filter((c) => c.id !== id);
  return comments.length === pat.comments.length ? pat : { ...pat, comments };
}

// ------------------------------------------------------------------ line and track operations

/**
 * After an empty line was inserted at `line` in one track: that track's comments at or below it
 * move down with their cells, and those pushed past the end are dropped like the cells. Chord
 * markers belong to the pattern, not to a track, so they stay.
 */
export function commentsAfterLineInsert(pat: Pattern, track: number, line: number): Pattern {
  return shiftTrackComments(pat, track, (c) => (c.line >= line ? c.line + 1 : c.line));
}

/** After the line `line` was deleted in one track: its comments go with it, later ones move up. */
export function commentsAfterLineDelete(pat: Pattern, track: number, line: number): Pattern {
  return shiftTrackComments(pat, track, (c) => (c.line === line ? -1 : c.line > line ? c.line - 1 : c.line));
}

function shiftTrackComments(pat: Pattern, track: number, newLine: (c: LineComment) => number): Pattern {
  if (!pat.comments.some((c) => c.track === track)) return pat;
  const comments = pat.comments
    .map((c) => (c.track === track ? { ...c, line: newLine(c) } : c))
    .filter((c) => c.line >= 0 && c.line < pat.lines)
    .sort(byPosition);
  return { ...pat, comments };
}

/** After a track was deleted: its comments go, comments of later tracks follow their track. */
export function commentsAfterTrackDelete(pat: Pattern, track: number): Pattern {
  if (!pat.comments.some((c) => c.track !== null && c.track >= track)) return pat;
  const comments = pat.comments
    .filter((c) => c.track !== track)
    .map((c) => (c.track !== null && c.track > track ? { ...c, track: c.track - 1 } : c));
  return { ...pat, comments };
}

/** Drops chord markers and comments at or past `lines`, for a pattern that got shorter. */
export function dropAnnotationsPast(pat: Pattern, lines: number): Pattern {
  const chords = pat.chords.filter((m) => m.line < lines);
  const comments = pat.comments.filter((c) => c.line < lines);
  if (chords.length === pat.chords.length && comments.length === pat.comments.length) return pat;
  return { ...pat, chords, comments };
}

/** A deep copy of a pattern with a new ID. Comments get new IDs, so every comment ID stays unique. */
export function clonePattern(pat: Pattern, id: string, name: string, commentId: () => string): Pattern {
  const copy = structuredClone(pat);
  return { ...copy, id, name, comments: copy.comments.map((c) => ({ ...c, id: commentId() })) };
}

// ------------------------------------------------------------------ song-order listing

export interface CommentEntry {
  comment: LineComment;
  pattern: Pattern;
  /** First order position that plays the pattern, or -1 when the pattern is not in the song. */
  orderIndex: number;
}

/**
 * All comments in song order. A pattern played several times lists its comments once, at its
 * first order position; patterns outside the song come last.
 */
export function commentsInSongOrder(p: Project): CommentEntry[] {
  const out: CommentEntry[] = [];
  const seen = new Set<string>();
  const patterns = new Map(p.patterns.map((x) => [x.id, x]));
  const add = (pattern: Pattern, orderIndex: number) => {
    seen.add(pattern.id);
    for (const comment of [...pattern.comments].sort(byPosition)) out.push({ comment, pattern, orderIndex });
  };
  p.order.forEach((id, i) => {
    const pattern = patterns.get(id);
    if (pattern && !seen.has(id)) add(pattern, i);
  });
  for (const pattern of p.patterns) if (!seen.has(pattern.id)) add(pattern, -1);
  return out;
}

// ------------------------------------------------------------------ note relations

/** Interval names above a chord root, in semitones. */
const INTERVALS = ['R', 'b2', '2', 'b3', '3', '4', 'b5', '5', '#5', '6', 'b7', '7'];

export interface NoteHarmony {
  /** Scale degree in the key in force ("1".."7", or with b/# outside the scale); null without a key. */
  degree: string | null;
  inKey: boolean;
  chord: { symbol: string; valid: false } | { symbol: string; valid: true; chordTone: boolean; interval: string } | null;
}

/** How a sounding note relates to the key and the chord in force. */
export function noteHarmony(note: number, key: MusicalKey | null, marker: ChordMarker | null): NoteHarmony {
  const degree = key ? scaleDegree(note, key) : null;
  const inKey = degree !== null && /^\d$/.test(degree);
  let chord: NoteHarmony['chord'] = null;
  if (marker) {
    const parsed: Chord | null = parseChord(marker.symbol);
    if (!parsed) chord = { symbol: marker.symbol, valid: false };
    else {
      const pc = ((note % 12) + 12) % 12;
      chord = { symbol: marker.symbol, valid: true, chordTone: parsed.tones.has(pc), interval: INTERVALS[(pc - parsed.root + 12) % 12] };
    }
  }
  return { degree, inKey, chord };
}
