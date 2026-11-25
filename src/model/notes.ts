import type { EffectType, Note } from './types';

const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

/** Tracker-style note name: 60 -> "C-4". */
export function noteName(note: Note): string {
  const octave = Math.floor(note / 12) - 1;
  return NAMES[((note % 12) + 12) % 12] + (octave < 0 ? '-' : String(octave));
}

/** Effect letters shown in the pattern editor's fx column. */
export const FX_LETTERS: Record<EffectType, string> = {
  slideUp: 'U',
  slideDown: 'D',
  porta: 'P',
  vibrato: 'V',
  volSlide: 'A',
  cut: 'C',
  retrig: 'R',
};

export const FX_BY_LETTER: Record<string, EffectType> = Object.fromEntries(
  Object.entries(FX_LETTERS).map(([type, letter]) => [letter, type as EffectType]),
);

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function hex(v: number, digits: number): string {
  return v.toString(16).toUpperCase().padStart(digits, '0');
}
