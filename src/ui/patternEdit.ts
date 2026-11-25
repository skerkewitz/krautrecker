import { blockToText, tryTextToBlock } from '../io/patternText';
import { clamp, FX_BY_LETTER } from '../model/notes';
import { NOTE_CUT, NOTE_OFF, type Cell, type Effect, type Pattern } from '../model/types';
import { clonePatternCells, currentPattern, Field, FIELD_COUNT, fxField, store, setCell, updatePattern, type Cursor, type Selection } from './store';
import { commentsAfterLineDelete, commentsAfterLineInsert } from './harmonyEdit';
import { readClipboardText, writeClipboardText } from './systemClipboard';

/**
 * Pattern editing operations used by the keyboard and MIDI handlers. They read and write the
 * store; the pattern editor component only translates events into these calls.
 */

/** FT2-style piano layout by physical key (KeyboardEvent.code), so QWERTZ and AZERTY work too. */
export const NOTE_KEYS: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

export function keyToNote(code: string, octave: number): number | null {
  const off = NOTE_KEYS[code];
  if (off === undefined) return null;
  const n = (octave + 1) * 12 + off;
  return n >= 0 && n <= 127 ? n : null;
}

/** Flat column positions (track, column) of a pattern, left to right. */
export function flatColumns(pat: Pattern): { track: number; column: number }[] {
  const out: { track: number; column: number }[] = [];
  pat.tracks.forEach((t, track) => {
    for (let column = 0; column < t.noteColumns; column++) out.push({ track, column });
  });
  return out;
}

function flatIndex(pat: Pattern, track: number, column: number): number {
  return flatColumns(pat).findIndex((f) => f.track === track && f.column === column);
}

export function selectionRect(pat: Pattern, sel: Selection) {
  const a = flatIndex(pat, sel.anchor.track, sel.anchor.column);
  const b = flatIndex(pat, sel.head.track, sel.head.column);
  return {
    col0: Math.max(0, Math.min(a, b)),
    col1: Math.max(a, b),
    line0: Math.max(0, Math.min(sel.anchor.line, sel.head.line)),
    line1: Math.min(pat.lines - 1, Math.max(sel.anchor.line, sel.head.line)),
  };
}

// ------------------------------------------------------------------ cursor

export function moveCursor(dLine: number, dField: number, extend = false): void {
  const s = store.getState();
  const pat = currentPattern(s);
  if (!pat || pat.tracks.length === 0) return;
  let { track, column, field, line } = s.ui.cursor;
  if (dLine !== 0) line = (((line + dLine) % pat.lines) + pat.lines) % pat.lines;
  if (dField !== 0) {
    const flat = flatColumns(pat);
    let fi = flatIndex(pat, track, column) * FIELD_COUNT + field + dField;
    const total = flat.length * FIELD_COUNT;
    fi = ((fi % total) + total) % total;
    const f = flat[Math.floor(fi / FIELD_COUNT)];
    track = f.track;
    column = f.column;
    field = fi % FIELD_COUNT;
  }
  setCursor({ track, column, field, line }, extend);
}

export function setCursor(cursor: Cursor, extend = false): void {
  const s = store.getState();
  const old = s.ui.cursor;
  let selection = s.ui.selection;
  if (extend) {
    const anchor = selection?.anchor ?? { track: old.track, column: old.column, line: old.line };
    selection = { anchor, head: { track: cursor.track, column: cursor.column, line: cursor.line } };
  } else selection = null;
  store.setUi({ cursor, selection });
}

export function jumpTrack(delta: number): void {
  const s = store.getState();
  const pat = currentPattern(s);
  if (!pat || pat.tracks.length === 0) return;
  const n = pat.tracks.length;
  const track = (((s.ui.cursor.track + delta) % n) + n) % n;
  setCursor({ ...s.ui.cursor, track, column: 0, field: 0 });
}

function advance(): void {
  const s = store.getState();
  if (s.ui.editStep > 0) moveCursor(s.ui.editStep, 0);
}

// ------------------------------------------------------------------ entry

export function enterNote(note: number | typeof NOTE_OFF | typeof NOTE_CUT): void {
  const s = store.getState();
  const c = s.ui.cursor;
  store.update((p) => setCell(p, s.ui.currentPatternId, c.track, c.line, c.column, (cell) => ({ ...(cell ?? {}), note })));
  advance();
}

/** Types one hex digit (or effect letter) into the field under the cursor. */
export function enterChar(ch: string): boolean {
  const s = store.getState();
  const c = s.ui.cursor;
  const upper = ch.toUpperCase();
  const fxf = fxField(c.field);
  if (fxf?.part === 'type') {
    const type = FX_BY_LETTER[upper];
    if (!type) return false;
    store.update((p) =>
      setCell(p, s.ui.currentPatternId, c.track, c.line, c.column, (cell) => ({
        ...(cell ?? {}),
        fx: withEffect(cell?.fx, fxf.index, { type, value: cell?.fx?.[fxf.index]?.value ?? 0 }),
      })),
    );
    advance();
    return true;
  }
  if (!/^[0-9A-F]$/.test(upper)) return false;
  const d = parseInt(upper, 16);
  const tpl = s.project.timing.ticksPerLine;
  const apply = (cell: Cell | null): Cell | null => {
    const next: Cell = { ...(cell ?? {}) };
    switch (c.field) {
      case Field.VolHi:
      case Field.VolLo: {
        const v = next.volume ?? 0;
        next.volume = clamp(c.field === Field.VolHi ? (d << 4) | (v & 15) : (v & 0xf0) | d, 0, 127);
        break;
      }
      case Field.PanHi:
      case Field.PanLo: {
        const v = (next.pan ?? 0) + 64;
        const raw = c.field === Field.PanHi ? (d << 4) | (v & 15) : (v & 0xf0) | d;
        next.pan = clamp(raw, 0, 127) - 64;
        break;
      }
      case Field.Delay:
        next.delay = clamp(d, 0, tpl - 1);
        break;
      default: {
        if (!fxf) return cell;
        const fx = next.fx?.[fxf.index] ?? { type: 'slideUp' as const, value: 0 };
        const v = fx.value;
        next.fx = withEffect(next.fx, fxf.index, { type: fx.type, value: fxf.part === 'hi' ? (d << 4) | (v & 15) : (v & 0xf0) | d });
      }
    }
    return next;
  };
  store.update((p) => setCell(p, s.ui.currentPatternId, c.track, c.line, c.column, apply));
  advance();
  return true;
}

/** Returns the effect list with column `index` set (or cleared); undefined when no effect is left. */
export function withEffect(list: (Effect | null)[] | undefined, index: number, fx: Effect | null): (Effect | null)[] | undefined {
  const next = (list ?? []).slice();
  while (next.length <= index) next.push(null);
  next[index] = fx;
  while (next.length > 0 && !next[next.length - 1]) next.pop();
  return next.length ? next : undefined;
}

/** Clears the field under the cursor, or the whole selection. */
export function clearAtCursor(): void {
  const s = store.getState();
  if (s.ui.selection) {
    deleteSelection();
    return;
  }
  const c = s.ui.cursor;
  store.update((p) =>
    setCell(p, s.ui.currentPatternId, c.track, c.line, c.column, (cell) => {
      if (!cell) return null;
      const next = { ...cell };
      if (c.field === Field.Note) {
        delete next.note;
        delete next.delay;
      } else if (c.field <= Field.VolLo) delete next.volume;
      else if (c.field <= Field.PanLo) delete next.pan;
      else if (c.field === Field.Delay) delete next.delay;
      else {
        const fxf = fxField(c.field);
        if (fxf) next.fx = withEffect(next.fx, fxf.index, null);
        if (!next.fx) delete next.fx;
      }
      return next;
    }),
  );
  advance();
}

/** Inserts an empty line in the cursor's track, pushing the rest down. */
export function insertLine(): void {
  const s = store.getState();
  const { track, line } = s.ui.cursor;
  store.update((p) =>
    updatePattern(p, s.ui.currentPatternId, (pat) => {
      const next = clonePatternCells(pat);
      const t = next.tracks[track];
      if (!t) return pat;
      t.cells.splice(line, 0, Array.from({ length: t.noteColumns }, () => null));
      t.cells.length = pat.lines;
      return commentsAfterLineInsert(next, track, line);
    }),
  );
}

/** Deletes the line above the cursor in the cursor's track, pulling the rest up. */
export function backspaceLine(): void {
  const s = store.getState();
  const { track, line } = s.ui.cursor;
  if (line === 0) return;
  store.update((p) =>
    updatePattern(p, s.ui.currentPatternId, (pat) => {
      const next = clonePatternCells(pat);
      const t = next.tracks[track];
      if (!t) return pat;
      t.cells.splice(line - 1, 1);
      t.cells.push(Array.from({ length: t.noteColumns }, () => null));
      return commentsAfterLineDelete(next, track, line - 1);
    }),
  );
  moveCursor(-1, 0);
}

// ------------------------------------------------------------------ clipboard

let clipboard: (Cell | null)[][] | null = null;

export function copySelection(): boolean {
  const s = store.getState();
  const pat = currentPattern(s);
  if (!pat) return false;
  const sel = s.ui.selection ?? { anchor: s.ui.cursor, head: s.ui.cursor };
  const r = selectionRect(pat, sel);
  const flat = flatColumns(pat);
  clipboard = [];
  for (let l = r.line0; l <= r.line1; l++) {
    const row: (Cell | null)[] = [];
    for (let fc = r.col0; fc <= r.col1; fc++) {
      const { track, column } = flat[fc];
      const cell = pat.tracks[track].cells[l]?.[column] ?? null;
      row.push(cell ? structuredClone(cell) : null);
    }
    clipboard.push(row);
  }
  // The system clipboard gets the same block as pattern text, for other apps and other tabs.
  const tracks: number[] = [];
  for (let fc = r.col0; fc <= r.col1; fc++) {
    if (fc > r.col0 && flat[fc].track === flat[fc - 1].track) tracks[tracks.length - 1]++;
    else tracks.push(1);
  }
  writeClipboardText(blockToText({ cells: clipboard, tracks }));
  return true;
}

export function deleteSelection(): void {
  const s = store.getState();
  const pat = currentPattern(s);
  if (!pat || !s.ui.selection) return;
  const r = selectionRect(pat, s.ui.selection);
  const flat = flatColumns(pat);
  store.update((p) =>
    updatePattern(p, pat.id, (pt) => {
      const next = clonePatternCells(pt);
      for (let l = r.line0; l <= r.line1; l++) {
        for (let fc = r.col0; fc <= r.col1; fc++) {
          const { track, column } = flat[fc];
          next.tracks[track].cells[l][column] = null;
        }
      }
      return next;
    }),
  );
}

export function cutSelection(): void {
  if (copySelection()) deleteSelection();
}

/**
 * Pastes at the cursor: the system clipboard when it holds pattern text, else the internal
 * clipboard. Reading the system clipboard is asynchronous, so the position is taken at the key press.
 */
export async function paste(): Promise<void> {
  const s = store.getState();
  const patternId = s.ui.currentPatternId;
  const cursor = s.ui.cursor;
  const text = await readClipboardText();
  const data = (text === null ? null : tryTextToBlock(text)?.cells) ?? clipboard;
  const pat = store.getState().project.patterns.find((p) => p.id === patternId);
  if (!pat || !data) return;
  const flat = flatColumns(pat);
  const start = flatIndex(pat, cursor.track, cursor.column);
  if (start < 0) return;
  store.update((p) =>
    updatePattern(p, pat.id, (pt) => {
      const next = clonePatternCells(pt);
      data.forEach((row, dl) => {
        const l = cursor.line + dl;
        if (l >= pt.lines) return;
        row.forEach((cell, dc) => {
          const f = flat[start + dc];
          if (!f) return;
          next.tracks[f.track].cells[l][f.column] = cell ? structuredClone(cell) : null;
        });
      });
      return next;
    }),
  );
}

export function selectAllInTrack(): void {
  const s = store.getState();
  const pat = currentPattern(s);
  if (!pat) return;
  const t = s.ui.cursor.track;
  const cols = pat.tracks[t]?.noteColumns ?? 1;
  store.setUi({ selection: { anchor: { track: t, column: 0, line: 0 }, head: { track: t, column: cols - 1, line: pat.lines - 1 } } });
}
