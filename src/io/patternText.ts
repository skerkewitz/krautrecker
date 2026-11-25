import { FX_BY_LETTER, FX_LETTERS, hex, noteName } from '../model/notes';
import { FX_COLUMNS, NOTE_CUT, NOTE_OFF, type Cell, type Effect, type Pattern } from '../model/types';

/**
 * Pattern text: pattern cells as plain, tracker-style text, for the clipboard and for writing
 * songs outside the editor. A block looks like this:
 *
 *   Krautrecker pattern text 1
 *   lines: 2
 *   tracks: 2 1
 *   00 | C-2 7F .. . ... ... : ... .. .. . ... ... | E-4 60 40 . V23 ... |
 *   01 | OFF .. .. . ... ... : ^^^ .. .. 3 R03 A10 | ... .. .. . ... ... |
 *
 * Each note column has six fields: note, volume (00-7F), pan (00-7F, 40 = centre), note delay
 * (one hex digit, in ticks) and two effects (letter + hex byte, letters as in the editor). "." marks
 * an empty field. `|` separates tracks and `:` the note columns inside a track; the header line
 * `tracks:` gives the note columns per track, and each line starts with its hex line number.
 * Lines starting with `#` are comments.
 */

export const PATTERN_TEXT_MAGIC = 'Krautrecker pattern text';
export const PATTERN_TEXT_VERSION = 1;

/** A rectangle of cells: `cells[line][column]`, columns flat from left to right. */
export interface CellBlock {
  cells: (Cell | null)[][];
  /** Note columns per track, left to right. Sums to the number of columns. */
  tracks: number[];
}

export class PatternTextError extends Error {
  /** 1-based position in the text. */
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(`line ${line}, column ${column}: ${message}`);
    this.name = 'PatternTextError';
    this.line = line;
    this.column = column;
  }
}

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
const EMPTY_CELL = '... .. .. . ... ...';
const CELL_WIDTH = EMPTY_CELL.length;
/** The pattern editor's limit. */
const MAX_LINES = 256;

// ------------------------------------------------------------------ writing

export interface TextOptions {
  /** Shown in a comment line after the magic line. */
  title?: string;
  /** Track names, shown in a comment line above the data, aligned with the tracks. */
  trackNames?: string[];
}

export function cellToText(cell: Cell | null): string {
  if (!cell) return EMPTY_CELL;
  const n = cell.note;
  const note = n === undefined ? '...' : n === NOTE_OFF ? 'OFF' : n === NOTE_CUT ? '^^^' : noteName(n);
  const vol = cell.volume === undefined ? '..' : hex(cell.volume, 2);
  const pan = cell.pan === undefined ? '..' : hex(cell.pan + 64, 2);
  const delay = cell.delay === undefined ? '.' : hex(cell.delay, 1);
  const fx: string[] = [];
  for (let i = 0; i < FX_COLUMNS; i++) {
    const e = cell.fx?.[i];
    fx.push(e ? FX_LETTERS[e.type] + hex(e.value, 2) : '...');
  }
  return [note, vol, pan, delay, ...fx].join(' ');
}

function lineDigits(lines: number): number {
  return Math.max(2, hex(Math.max(0, lines - 1), 1).length);
}

export function blockToText(block: CellBlock, options: TextOptions = {}): string {
  const lines = block.cells.length;
  const out = [`${PATTERN_TEXT_MAGIC} ${PATTERN_TEXT_VERSION}`];
  if (options.title) out.push(`# ${options.title}`);
  out.push('# note vol pan delay fx fx; "." = empty, pan 40 = centre, OFF = note off, ^^^ = note cut');
  out.push(`lines: ${lines}`);
  out.push(`tracks: ${block.tracks.join(' ')}`);
  const digits = lineDigits(lines);
  if (options.trackNames) {
    const heads = block.tracks.map((cols, t) => {
      const width = cols * CELL_WIDTH + (cols - 1) * 3;
      const name = `${options.trackNames?.[t] ?? ''}`.slice(0, width);
      return ` ${name.padEnd(width)} `;
    });
    out.push(`#${' '.repeat(digits)}|${heads.join('|')}|`);
  }
  block.cells.forEach((row, l) => {
    const parts: string[] = [];
    let c = 0;
    for (const cols of block.tracks) {
      const cells: string[] = [];
      for (let i = 0; i < cols; i++) cells.push(cellToText(row[c++] ?? null));
      parts.push(` ${cells.join(' : ')} `);
    }
    out.push(`${hex(l, digits)} |${parts.join('|')}|`);
  });
  return out.join('\n') + '\n';
}

/** The whole pattern as a block: every line, every note column, grouped by track. */
export function patternBlock(pattern: Pattern): CellBlock {
  const cells: (Cell | null)[][] = [];
  for (let l = 0; l < pattern.lines; l++) {
    const row: (Cell | null)[] = [];
    for (const t of pattern.tracks) for (let c = 0; c < t.noteColumns; c++) row.push(t.cells[l]?.[c] ?? null);
    cells.push(row);
  }
  return { cells, tracks: pattern.tracks.map((t) => t.noteColumns) };
}

export function patternToText(pattern: Pattern, trackNames?: string[]): string {
  return blockToText(patternBlock(pattern), { title: `${pattern.name} (${pattern.id})`, trackNames });
}

// ------------------------------------------------------------------ reading

interface Token {
  text: string;
  /** 0-based character index in the line. */
  at: number;
}

function tokens(s: string, offset: number): Token[] {
  const out: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push({ text: m[0], at: offset + m.index });
  return out;
}

function parseHex(t: Token, digits: number, max: number, what: string, fail: (msg: string, at: number) => never): number {
  if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(t.text)) fail(`${what} must be ${digits} hex digit${digits > 1 ? 's' : ''} or "${'.'.repeat(digits)}", got "${t.text}"`, t.at);
  const v = parseInt(t.text, 16);
  if (v > max) fail(`${what} ${t.text.toUpperCase()} is out of range (max ${hex(max, digits)})`, t.at);
  return v;
}

function parseCell(fields: Token[], fail: (msg: string, at: number) => never): Cell | null {
  const [noteT, volT, panT, delayT, ...fxT] = fields;
  const cell: Cell = {};
  const nt = noteT.text.toUpperCase();
  if (nt === 'OFF') cell.note = NOTE_OFF;
  else if (nt === '^^^') cell.note = NOTE_CUT;
  else if (nt !== '...') {
    const name = NOTE_NAMES.indexOf(nt.slice(0, 2));
    const oct = nt.length === 3 ? (nt[2] === '-' ? -1 : /[0-9]/.test(nt[2]) ? Number(nt[2]) : NaN) : NaN;
    if (name < 0 || Number.isNaN(oct)) fail(`note must be like C-4, C#4, OFF, ^^^ or "...", got "${noteT.text}"`, noteT.at);
    const note = (oct + 1) * 12 + name;
    if (note > 127) fail(`note ${noteT.text} is above G-9`, noteT.at);
    cell.note = note;
  }
  if (volT.text !== '..') cell.volume = parseHex(volT, 2, 0x7f, 'volume', fail);
  if (panT.text !== '..') cell.pan = parseHex(panT, 2, 0x7f, 'pan', fail) - 64;
  if (delayT.text !== '.') cell.delay = parseHex(delayT, 1, 0xf, 'delay', fail);
  const fx: (Effect | null)[] = [];
  for (const t of fxT) {
    if (t.text === '...') {
      fx.push(null);
      continue;
    }
    const type = FX_BY_LETTER[t.text[0].toUpperCase()];
    if (!type) fail(`unknown effect "${t.text}" (letters: ${Object.values(FX_LETTERS).join(' ')})`, t.at);
    fx.push({ type, value: parseHex({ text: t.text.slice(1), at: t.at + 1 }, 2, 0xff, 'effect value', fail) });
  }
  while (fx.length > 0 && !fx[fx.length - 1]) fx.pop();
  if (fx.length) cell.fx = fx;
  return Object.keys(cell).length ? cell : null;
}

/** Parses pattern text. Throws a PatternTextError with the line and column of the first problem. */
export function textToBlock(text: string): CellBlock {
  const rows = text.replace(/^﻿/, '').split(/\r?\n/);
  let i = 0;
  const fail = (msg: string, at = 0): never => {
    throw new PatternTextError(msg, i + 1, at + 1);
  };
  const skippable = (s: string) => s.trim() === '' || s.trimStart().startsWith('#');
  while (i < rows.length && skippable(rows[i])) i++;
  if (i >= rows.length) fail('empty text; expected the line "Krautrecker pattern text 1"');
  const magic = /^\s*Krautrecker pattern text\s+(\d+)\s*$/.exec(rows[i]);
  if (!magic) fail(`not pattern text: the first line must be "${PATTERN_TEXT_MAGIC} ${PATTERN_TEXT_VERSION}"`);
  if (Number(magic![1]) !== PATTERN_TEXT_VERSION) fail(`unsupported pattern text version ${magic![1]} (this app reads version ${PATTERN_TEXT_VERSION})`);
  i++;

  // Header: "key: value" lines up to the first data line.
  let lines: number | null = null;
  let tracks: number[] | null = null;
  for (; i < rows.length; i++) {
    const row = rows[i];
    if (skippable(row)) continue;
    const h = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(row);
    if (!h) break;
    const value = h[2];
    const at = row.indexOf(value, row.indexOf(':'));
    if (h[1] === 'lines') {
      if (!/^\d+$/.test(value) || Number(value) < 1) fail(`"lines" must be a positive number, got "${value}"`, at);
      lines = Number(value);
    } else if (h[1] === 'tracks') {
      const counts = value.split(/\s+/);
      if (value === '' || counts.some((c) => !/^\d+$/.test(c) || Number(c) < 1)) fail(`"tracks" must list the note columns per track, e.g. "tracks: 2 1 3", got "${value}"`, at);
      tracks = counts.map(Number);
    } else fail(`unknown header "${h[1]}" (expected "lines" or "tracks")`, row.indexOf(h[1]));
  }
  if (lines === null) fail('missing header "lines: <count>" before the first data line');
  if (tracks === null) fail('missing header "tracks: <note columns per track>" before the first data line');

  const cells: (Cell | null)[][] = [];
  for (; i < rows.length; i++) {
    const row = rows[i];
    if (skippable(row)) continue;
    const m = /^(\s*)([0-9A-Fa-f]+)\s*\|/.exec(row);
    if (!m) fail(`expected a data line like "00 | C-4 70 .. . ... ... |"`, row.length - row.trimStart().length);
    if (cells.length >= lines!) fail(`more data lines than "lines: ${lines}"`);
    const number = parseInt(m![2], 16);
    if (number !== cells.length) fail(`line number ${m![2]} out of sequence; expected ${hex(cells.length, lineDigits(lines!))}`, m![1].length);
    // Split the rest at "|" into tracks and at ":" into note columns, keeping character offsets.
    let pos = m![0].length;
    const segments: { text: string; at: number }[] = [];
    for (const part of row.slice(pos).split('|')) {
      segments.push({ text: part, at: pos });
      pos += part.length + 1;
    }
    if (segments.length > 1 && segments[segments.length - 1].text.trim() === '') segments.pop();
    if (segments.length !== tracks!.length) fail(`expected ${tracks!.length} track${tracks!.length > 1 ? 's' : ''} separated by "|", found ${segments.length}`, segments[0].at);
    const cellRow: (Cell | null)[] = [];
    segments.forEach((seg, t) => {
      let cpos = seg.at;
      const cols = seg.text.split(':');
      if (cols.length !== tracks![t]) fail(`track ${t + 1}: expected ${tracks![t]} note column${tracks![t] > 1 ? 's' : ''} separated by ":", found ${cols.length}`, seg.at);
      for (const col of cols) {
        const fields = tokens(col, cpos);
        if (fields.length !== 4 + FX_COLUMNS) {
          fail(`a note column has ${4 + FX_COLUMNS} fields (note vol pan delay fx fx), found ${fields.length}`, fields[0]?.at ?? cpos);
        }
        cellRow.push(parseCell(fields, fail));
        cpos += col.length + 1;
      }
    });
    cells.push(cellRow);
  }
  if (cells.length < lines!) {
    i = rows.length - 1;
    fail(`expected ${lines} data lines, found ${cells.length}`);
  }
  return { cells, tracks: tracks! };
}

/** Parses pattern text, or returns null when the text is not valid pattern text. */
export function tryTextToBlock(text: string): CellBlock | null {
  try {
    return textToBlock(text);
  } catch (e) {
    if (e instanceof PatternTextError) return null;
    throw e;
  }
}

/**
 * The pattern with its cells replaced by a whole-pattern block. Tracks keep their device, volume,
 * pan and transpose; the line count and each track's note columns follow the block. Throws when
 * the block has a different number of tracks or a track with more than 8 note columns.
 */
export function patternWithBlock(pattern: Pattern, block: CellBlock): Pattern {
  if (block.tracks.length !== pattern.tracks.length) {
    throw new Error(`The text has ${block.tracks.length} tracks, but pattern "${pattern.name}" has ${pattern.tracks.length}.`);
  }
  const bad = block.tracks.findIndex((c) => c > 8);
  if (bad >= 0) throw new Error(`Track ${bad + 1} has ${block.tracks[bad]} note columns; the maximum is 8.`);
  if (block.cells.length > MAX_LINES) throw new Error(`The text has ${block.cells.length} lines; a pattern has at most ${MAX_LINES}.`);
  let first = 0;
  const tracks = pattern.tracks.map((t, ti) => {
    const cols = block.tracks[ti];
    const start = first;
    first += cols;
    return {
      ...t,
      noteColumns: cols,
      cells: block.cells.map((row) => row.slice(start, start + cols).map((c) => (c ? structuredClone(c) : null))),
    };
  });
  return { ...pattern, lines: block.cells.length, tracks };
}
