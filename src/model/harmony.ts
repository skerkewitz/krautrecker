import type { ChordMarker, Mode, MusicalKey, Pattern, Project } from './types';

/**
 * Harmony helpers: keys, scales and chord symbols. Pure and used by the editor (scale degrees,
 * chord display) and the musical checks (clashes, notes outside the key). Nothing here affects
 * the sound.
 */

/** Semitone steps of each mode from its tonic. */
export const MODES: Record<Mode, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export function pitchClassName(pc: number, flats = false): string {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[((pc % 12) + 12) % 12];
}

export function keyName(key: MusicalKey): string {
  return `${pitchClassName(key.root)} ${key.mode}`;
}

/** The seven pitch classes of a key. */
export function scalePitchClasses(key: MusicalKey): Set<number> {
  return new Set(MODES[key.mode].map((i) => (key.root + i) % 12));
}

/**
 * Scale degree of a note in a key, as musicians write it: "1".."7" for scale notes, with "b" or "#"
 * for notes outside the scale (relative to the major-scale degree, e.g. "b3", "#4").
 */
export function scaleDegree(note: number, key: MusicalKey): string {
  const interval = (((note - key.root) % 12) + 12) % 12;
  const steps = MODES[key.mode];
  const inScale = steps.indexOf(interval);
  if (inScale >= 0) return String(inScale + 1);
  const MAJOR_DEGREE = ['1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'];
  return MAJOR_DEGREE[interval];
}

export interface Chord {
  symbol: string;
  root: number;
  /** Lowest note's pitch class: the slash bass, or the root. */
  bass: number;
  /** All pitch classes of the chord, bass included. */
  tones: Set<number>;
}

/** Quality suffixes with their intervals above the root, longest first so "maj7" wins over "maj". */
const QUALITIES: [string, number[]][] = [
  ['maj9', [0, 4, 7, 11, 2]],
  ['maj7', [0, 4, 7, 11]],
  ['m7b5', [0, 3, 6, 10]],
  ['madd9', [0, 3, 7, 2]],
  ['add9', [0, 4, 7, 2]],
  ['sus2', [0, 2, 7]],
  ['sus4', [0, 5, 7]],
  ['dim7', [0, 3, 6, 9]],
  ['min7', [0, 3, 7, 10]],
  ['aug', [0, 4, 8]],
  ['dim', [0, 3, 6]],
  ['min', [0, 3, 7]],
  ['maj', [0, 4, 7]],
  ['m9', [0, 3, 7, 10, 2]],
  ['m7', [0, 3, 7, 10]],
  ['m6', [0, 3, 7, 9]],
  ['M7', [0, 4, 7, 11]],
  ['sus', [0, 5, 7]],
  ['9', [0, 4, 7, 10, 2]],
  ['7', [0, 4, 7, 10]],
  ['6', [0, 4, 7, 9]],
  ['5', [0, 7]],
  ['m', [0, 3, 7]],
  ['-', [0, 3, 7]],
  ['+', [0, 4, 8]],
  ['°', [0, 3, 6]],
  ['', [0, 4, 7]],
];

function parsePitchClass(s: string): { pc: number; rest: string } | null {
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(s);
  if (!m) return null;
  let pc = SHARP_NAMES.indexOf(m[1].toUpperCase());
  if (m[2] === '#') pc += 1;
  if (m[2] === 'b') pc -= 1;
  return { pc: (pc + 12) % 12, rest: m[3] };
}

/** Parses a chord symbol ("Em", "D/E", "Cmaj7", "Bbsus4", "F#m7b5"). Returns null if it is not one. */
export function parseChord(symbol: string): Chord | null {
  const text = symbol.trim();
  const [main, slash] = text.split('/');
  const head = parsePitchClass(main ?? '');
  if (!head) return null;
  const quality = QUALITIES.find(([suffix]) => head.rest === suffix);
  if (!quality) return null;
  const tones = new Set(quality[1].map((i) => (head.pc + i) % 12));
  let bass = head.pc;
  if (slash !== undefined) {
    const b = parsePitchClass(slash);
    if (!b || b.rest !== '') return null;
    bass = b.pc;
    tones.add(bass);
  }
  return { symbol: text, root: head.pc, bass, tones };
}

/** The key in force for a pattern: its own key, else the song key. */
export function patternKey(project: Project, pattern: Pattern): MusicalKey | null {
  return pattern.key ?? project.key;
}

/**
 * The chord marker in force at each line of the song, following the order list: a marker holds
 * until the next one, also across pattern boundaries. Returns one entry per song line.
 */
export function chordsBySongLine(project: Project): (ChordMarker | null)[] {
  const patterns = new Map(project.patterns.map((p) => [p.id, p]));
  const out: (ChordMarker | null)[] = [];
  let current: ChordMarker | null = null;
  for (const id of project.order) {
    const pat = patterns.get(id);
    if (!pat) continue;
    const markers = [...pat.chords].sort((a, b) => a.line - b.line);
    let m = 0;
    for (let line = 0; line < pat.lines; line++) {
      while (m < markers.length && markers[m].line <= line) current = markers[m++];
      out.push(current);
    }
  }
  return out;
}
