import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IR } from '../compiler/ir';
import { newTrack } from '../model/defaults';
import { FX_LETTERS, hex, noteName } from '../model/notes';
import { NOTE_CUT, NOTE_OFF, type Cell, type Pattern } from '../model/types';
import { auditionOff, auditionOn, playFromCursor, playPattern, togglePlay } from './actions';
import {
  backspaceLine,
  clearAtCursor,
  copySelection,
  cutSelection,
  enterChar,
  enterNote,
  insertLine,
  jumpTrack,
  keyToNote,
  moveCursor,
  paste,
  selectAllInTrack,
  selectionRect,
  setCursor,
} from './patternEdit';
import { clonePatternCells, Field, FIELD_COUNT, store, updatePattern, useStore } from './store';
import { measureChar, prepareCanvas, theme } from './theme';

/** Characters per note column: "C-4 7F 40 0 U08" plus a gap. */
const COL_CHARS = 16;
const GUTTER_CHARS = 4;
const HEADER_H = 46;
/** Character offset of each field inside a note column. */
const FIELD_X = [0, 4, 5, 7, 8, 10, 12, 13, 14];
const FIELD_W = [3, 1, 1, 1, 1, 1, 1, 1, 1];

function trackChars(cols: number): number {
  return cols * COL_CHARS + 1;
}

/** Cells the compiler flagged (stolen voice, clamped pitch...), keyed "pattern:track:line:col". */
function diagnosticMarks(ir: IR): Map<string, 'warn' | 'error'> {
  const marks = new Map<string, 'warn' | 'error'>();
  const key = (s: { patternId: string; track: number; line: number; column: number }) => `${s.patternId}:${s.track}:${s.line}:${s.column}`;
  for (const d of ir.diagnostics) {
    if (!d.source || d.severity === 'info') continue;
    const k = key(d.source);
    if (d.severity === 'error' || !marks.has(k)) marks.set(k, d.severity === 'error' ? 'error' : 'warn');
  }
  for (const lane of ir.voices) for (const e of lane) if (e.type === 'keyOn' && e.stolen) marks.set(key(e.source), 'error');
  return marks;
}

export function PatternEditor() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const pattern = project.patterns.find((p) => p.id === ui.currentPatternId);
  const ir = useMemo(() => store.songIR(), [project]);
  const marks = useMemo(() => diagnosticMarks(ir), [ir]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  const [cw, setCw] = useState(8);
  const dragging = useRef(false);

  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const ctx = canvasRef.current!.getContext('2d')!;
    setCw(measureChar(ctx));
  }, []);

  // The line shown at the centre: the play position when following, otherwise the cursor.
  const tpl = project.timing.ticksPerLine;
  let playLine = -1;
  if (ui.playing && pattern) {
    if (ui.playMode === 'pattern') playLine = Math.floor(ui.playTick / tpl) % pattern.lines;
    else {
      const info = ir.lines[Math.floor(ui.playTick / tpl)];
      if (info && info.patternId === pattern.id && (ui.orderIndex < 0 || info.orderIndex === ui.orderIndex)) playLine = info.line;
    }
  }
  const centerLine = ui.follow && playLine >= 0 ? playLine : ui.cursor.line;

  const totalChars = GUTTER_CHARS + (pattern?.tracks.reduce((a, t) => a + trackChars(t.noteColumns), 0) ?? 0);
  const canvasW = Math.max(size.w, totalChars * cw + 8);
  const canvasH = Math.max(50, size.h - HEADER_H - 14);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pattern) return;
    const ctx = prepareCanvas(canvas, canvasW, canvasH);
    drawPattern(ctx, canvasW, canvasH, cw, pattern, ui, centerLine, playLine, marks, project.timing.linesPerBeat);
  });

  // Keep the cursor's track scrolled into view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pattern) return;
    let x = GUTTER_CHARS * cw;
    for (let t = 0; t < ui.cursor.track; t++) x += trackChars(pattern.tracks[t].noteColumns) * cw;
    const w = trackChars(pattern.tracks[ui.cursor.track]?.noteColumns ?? 1) * cw;
    if (x < el.scrollLeft) el.scrollLeft = x - GUTTER_CHARS * cw;
    else if (x + w > el.scrollLeft + el.clientWidth) el.scrollLeft = x + w - el.clientWidth + 10;
  }, [ui.cursor.track, pattern, cw]);

  if (!pattern) return <div className="panel-empty">No pattern. Create one in the order list.</div>;

  const hit = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const rows = Math.floor(canvasH / theme.lineHeight);
    const line = centerLine - Math.floor(rows / 2) + Math.floor(y / theme.lineHeight);
    let c = Math.floor(x / cw) - GUTTER_CHARS;
    for (let t = 0; t < pattern.tracks.length; t++) {
      const tc = trackChars(pattern.tracks[t].noteColumns);
      if (c < tc) {
        const column = Math.min(pattern.tracks[t].noteColumns - 1, Math.floor(c / COL_CHARS));
        const off = c - column * COL_CHARS;
        let field = 0;
        for (let f = 0; f < FIELD_COUNT; f++) if (off >= FIELD_X[f]) field = f;
        return { track: t, column, field, line: Math.max(0, Math.min(pattern.lines - 1, line)) };
      }
      c -= tc;
    }
    return null;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    canvasRef.current!.focus();
    const h = hit(e);
    if (!h) return;
    setCursor(h, e.shiftKey);
    dragging.current = true;
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging.current || !(e.buttons & 1)) return;
    const h = hit(e);
    if (h) setCursor(h, true);
  };
  const onWheel = (e: React.WheelEvent) => {
    moveCursor(Math.sign(e.deltaY) * (e.shiftKey ? 8 : 2), 0);
  };

  return (
    <div className="pattern-editor">
      <PatternBar pattern={pattern} />
      <div className="pe-scroll" ref={scrollRef}>
        <div className="pe-headers" style={{ width: canvasW, height: HEADER_H }}>
          <div style={{ width: GUTTER_CHARS * cw }} />
          {pattern.tracks.map((t, i) => (
            <TrackHeader key={i} pattern={pattern} index={i} width={trackChars(t.noteColumns) * cw} active={i === ui.cursor.track} />
          ))}
        </div>
        <canvas
          ref={canvasRef}
          className="pe-canvas"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={() => (dragging.current = false)}
          onWheel={onWheel}
        />
      </div>
    </div>
  );
}

function drawPattern(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cw: number,
  pat: Pattern,
  ui: ReturnType<typeof store.getState>['ui'],
  centerLine: number,
  playLine: number,
  marks: Map<string, 'warn' | 'error'>,
  lpb: number,
) {
  const LH = theme.lineHeight;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);
  const rows = Math.floor(h / LH);
  const first = centerLine - Math.floor(rows / 2);
  const sel = ui.selection ? selectionRect(pat, ui.selection) : null;

  // Track x positions (in chars).
  const trackX: number[] = [];
  let x = GUTTER_CHARS;
  for (const t of pat.tracks) {
    trackX.push(x);
    x += trackChars(t.noteColumns);
  }

  let flatBase = 0;
  const flatStart = pat.tracks.map((t) => {
    const b = flatBase;
    flatBase += t.noteColumns;
    return b;
  });

  for (let r = 0; r < rows; r++) {
    const line = first + r;
    if (line < 0 || line >= pat.lines) continue;
    const y = r * LH;
    const cy = y + LH / 2 + 1;
    // Row background: bars, beats, cursor and play rows.
    let bg = line % (lpb * 4) === 0 ? theme.bgBar : line % lpb === 0 ? theme.bgBeat : null;
    if (line === playLine) bg = theme.rowPlay;
    if (line === ui.cursor.line) bg = ui.editMode ? theme.rowCursorEdit : theme.rowCursor;
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, y, w, LH);
    }
    ctx.fillStyle = line % lpb === 0 ? theme.gutterBeat : theme.gutter;
    ctx.fillText(hex(line, 2).padStart(3, ' '), 2, cy);

    pat.tracks.forEach((t, ti) => {
      const row = t.cells[line] ?? [];
      for (let c = 0; c < t.noteColumns; c++) {
        const cx = (trackX[ti] + c * COL_CHARS) * cw;
        const fc = flatStart[ti] + c;
        if (sel && line >= sel.line0 && line <= sel.line1 && fc >= sel.col0 && fc <= sel.col1) {
          ctx.fillStyle = theme.selection;
          ctx.fillRect(cx - 2, y, (COL_CHARS - 0.5) * cw, LH);
        }
        const mark = marks.get(`${pat.id}:${ti}:${line}:${c}`);
        if (mark) {
          ctx.fillStyle = mark === 'error' ? theme.error : theme.warn;
          ctx.fillRect(cx - 2, y + 1, 3 * cw + 4, LH - 2);
        }
        drawCell(ctx, cx, cy, cw, row[c] ?? null);
      }
      // Track separator.
      ctx.fillStyle = theme.separator;
      ctx.fillRect((trackX[ti] + trackChars(t.noteColumns)) * cw - cw / 2, y, 1, LH);
    });
  }

  // Cursor box.
  const cr = ui.cursor.line - first;
  if (cr >= 0 && cr < rows && pat.tracks[ui.cursor.track]) {
    const cx = (trackX[ui.cursor.track] + ui.cursor.column * COL_CHARS + FIELD_X[ui.cursor.field]) * cw;
    ctx.strokeStyle = theme.cursorBox;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - 1.5, cr * LH + 1, FIELD_W[ui.cursor.field] * cw + 3, LH - 2);
  }
}

function drawCell(ctx: CanvasRenderingContext2D, x: number, cy: number, cw: number, cell: Cell | null) {
  const put = (text: string, color: string, at: number) => {
    ctx.fillStyle = color;
    ctx.fillText(text, x + at * cw, cy);
  };
  const n = cell?.note;
  if (n === NOTE_OFF) put('OFF', theme.noteOff, 0);
  else if (n === NOTE_CUT) put('^^^', theme.noteOff, 0);
  else if (typeof n === 'number') put(noteName(n), theme.note, 0);
  else put('---', theme.empty, 0);
  if (cell?.volume !== undefined) put(hex(cell.volume, 2), theme.vol, 4);
  else put('..', theme.empty, 4);
  if (cell?.pan !== undefined) put(hex(cell.pan + 64, 2), theme.pan, 7);
  else put('..', theme.empty, 7);
  if (cell?.delay !== undefined && cell.delay > 0) put(hex(cell.delay, 1), theme.delay, 10);
  else put('.', theme.empty, 10);
  if (cell?.fx) put(FX_LETTERS[cell.fx.type] + hex(cell.fx.value, 2), theme.fx, 12);
  else put('...', theme.empty, 12);
}

// ------------------------------------------------------------------ keyboard

const heldKeys = new Set<string>();

function onKeyDown(e: React.KeyboardEvent) {
  const s = store.getState();
  const ctrl = e.ctrlKey || e.metaKey;
  const handled = () => {
    e.preventDefault();
    e.stopPropagation();
  };

  if (ctrl) {
    switch (e.code) {
      case 'KeyC':
        copySelection();
        return handled();
      case 'KeyX':
        cutSelection();
        return handled();
      case 'KeyV':
        paste();
        return handled();
      case 'KeyA':
        selectAllInTrack();
        return handled();
    }
    return; // Ctrl+Z / Ctrl+Y are global.
  }

  switch (e.code) {
    case 'ArrowUp':
      moveCursor(-1, 0, e.shiftKey);
      return handled();
    case 'ArrowDown':
      moveCursor(1, 0, e.shiftKey);
      return handled();
    case 'ArrowLeft':
      moveCursor(0, e.shiftKey ? -FIELD_COUNT : -1, e.shiftKey);
      return handled();
    case 'ArrowRight':
      moveCursor(0, e.shiftKey ? FIELD_COUNT : 1, e.shiftKey);
      return handled();
    case 'PageUp':
      moveCursor(-16, 0, e.shiftKey);
      return handled();
    case 'PageDown':
      moveCursor(16, 0, e.shiftKey);
      return handled();
    case 'Home':
      setCursor({ ...s.ui.cursor, line: 0 }, e.shiftKey);
      return handled();
    case 'End': {
      const pat = s.project.patterns.find((p) => p.id === s.ui.currentPatternId);
      setCursor({ ...s.ui.cursor, line: (pat?.lines ?? 1) - 1 }, e.shiftKey);
      return handled();
    }
    case 'Tab':
      jumpTrack(e.shiftKey ? -1 : 1);
      return handled();
    case 'Escape':
      store.setUi({ editMode: !s.ui.editMode, selection: null });
      return handled();
    case 'Space':
      if (e.shiftKey) void playPattern(0);
      else togglePlay();
      return handled();
    case 'Enter':
    case 'NumpadEnter':
      void playFromCursor();
      return handled();
    case 'NumpadAdd':
      store.setUi({ octave: Math.min(8, s.ui.octave + 1) });
      return handled();
    case 'NumpadSubtract':
      store.setUi({ octave: Math.max(0, s.ui.octave - 1) });
      return handled();
    case 'Delete':
      if (s.ui.editMode) clearAtCursor();
      return handled();
    case 'Backspace':
      if (s.ui.editMode) backspaceLine();
      return handled();
    case 'Insert':
      if (s.ui.editMode) insertLine();
      return handled();
  }

  if (s.ui.cursor.field === Field.Note) {
    if (e.code === 'Digit1' || e.code === 'Backquote') {
      if (s.ui.editMode) enterNote(e.code === 'Digit1' ? NOTE_OFF : NOTE_CUT);
      return handled();
    }
    const note = keyToNote(e.code, s.ui.octave);
    if (note !== null) {
      if (!e.repeat) {
        auditionOn(`key:${e.code}`, note);
        heldKeys.add(e.code);
        if (s.ui.editMode) enterNote(note);
      }
      return handled();
    }
    return;
  }
  if (s.ui.editMode && e.key.length === 1 && !e.altKey) {
    if (enterChar(e.key)) handled();
  }
}

function onKeyUp(e: React.KeyboardEvent) {
  if (heldKeys.has(e.code)) {
    heldKeys.delete(e.code);
    auditionOff(`key:${e.code}`);
  }
}

// ------------------------------------------------------------------ header bars

function TrackHeader({ pattern, index, width, active }: { pattern: Pattern; index: number; width: number; active: boolean }) {
  const devices = useStore((s) => s.project.devices);
  const t = pattern.tracks[index];
  const setTrack = (fn: (pat: Pattern) => Pattern) => store.update((p) => updatePattern(p, pattern.id, fn));
  const setColumns = (n: number) =>
    setTrack((pat) => {
      const next = clonePatternCells(pat);
      const tr = next.tracks[index];
      tr.noteColumns = Math.max(1, Math.min(8, n));
      tr.cells = tr.cells.map((row) => Array.from({ length: tr.noteColumns }, (_, c) => row[c] ?? null));
      return next;
    });
  const dev = devices.find((d) => d.id === t.deviceId);
  return (
    <div className={`track-header${active ? ' active' : ''}`} style={{ width }} onMouseDown={() => t.deviceId && store.setUi({ selectedDeviceId: t.deviceId })}>
      <div className="th-row">
        <span className="th-num">{index + 1}</span>
        <select
          value={t.deviceId ?? ''}
          title="Device played by this track"
          onChange={(e) =>
            setTrack((pat) => ({ ...pat, tracks: pat.tracks.map((x, i) => (i === index ? { ...x, deviceId: e.target.value || null } : x)) }))
          }
        >
          <option value="">(no device)</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="th-row">
        <span className="th-mode">{dev ? dev.mode : ''}</span>
        <button title="Fewer note columns" onClick={() => setColumns(t.noteColumns - 1)}>
          −
        </button>
        <span title="Note columns">{t.noteColumns}</span>
        <button title="More note columns (chords)" onClick={() => setColumns(t.noteColumns + 1)}>
          +
        </button>
        <button
          title="Delete track"
          className="danger"
          onClick={() => {
            if (pattern.tracks.length > 1) setTrack((pat) => ({ ...pat, tracks: pat.tracks.filter((_, i) => i !== index) }));
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function PatternBar({ pattern }: { pattern: Pattern }) {
  const patterns = useStore((s) => s.project.patterns);
  const ui = useStore((s) => s.ui);
  return (
    <div className="pattern-bar">
      <label>
        Pattern
        <select value={pattern.id} onChange={(e) => store.setUi({ currentPatternId: e.target.value, orderIndex: store.getState().project.order.indexOf(e.target.value) })}>
          {patterns.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <input
        className="name"
        value={pattern.name}
        onChange={(e) => store.update((p) => updatePattern(p, pattern.id, (pat) => ({ ...pat, name: e.target.value })), `pname:${pattern.id}`)}
      />
      <label>
        Lines
        <input
          type="number"
          min={1}
          max={256}
          value={pattern.lines}
          onChange={(e) => {
            const lines = Math.max(1, Math.min(256, Number(e.target.value) || 1));
            store.update(
              (p) =>
                updatePattern(p, pattern.id, (pat) => ({
                  ...pat,
                  lines,
                  tracks: pat.tracks.map((t) => ({
                    ...t,
                    cells: Array.from({ length: lines }, (_, l) => t.cells[l] ?? Array.from({ length: t.noteColumns }, () => null)),
                  })),
                })),
              `plines:${pattern.id}`,
            );
          }}
        />
      </label>
      <button
        onClick={() =>
          store.update((p) =>
            updatePattern(p, pattern.id, (pat) => ({ ...pat, tracks: [...pat.tracks, newTrack(ui.selectedDeviceId, 1, pat.lines)] })),
          )
        }
      >
        + Track
      </button>
      <span className="hint">
        {ui.editMode ? 'EDIT' : 'play'} · oct {ui.octave} · step {ui.editStep}
      </span>
    </div>
  );
}
