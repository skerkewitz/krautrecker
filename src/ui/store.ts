import { useSyncExternalStore } from 'react';
import { compileSong } from '../compiler/compile';
import type { IR } from '../compiler/ir';
import type { Cell, Pattern, Project } from '../model/types';
import { loadLayout, type Layout } from './layout';

/**
 * App state: the project (with undo/redo), UI state and the compiled IR. The IR is derived:
 * it is recompiled whenever the project object changes and never stored.
 */

/** Sub-positions inside a note column: note, vol (2 digits), pan (2), delay, then per effect column a type letter and 2 digits. */
export const FIELD_COUNT = 12;
export const Field = {
  Note: 0,
  VolHi: 1,
  VolLo: 2,
  PanHi: 3,
  PanLo: 4,
  Delay: 5,
  FxType: 6,
  FxHi: 7,
  FxLo: 8,
  Fx2Type: 9,
  Fx2Hi: 10,
  Fx2Lo: 11,
} as const;

/** For a cursor field in an effect column: which effect column, and which part of it. */
export function fxField(field: number): { index: number; part: 'type' | 'hi' | 'lo' } | null {
  if (field < Field.FxType) return null;
  const rel = field - Field.FxType;
  return { index: Math.floor(rel / 3), part: (['type', 'hi', 'lo'] as const)[rel % 3] };
}

export interface Cursor {
  track: number;
  column: number;
  field: number;
  line: number;
}

/** A rectangular selection: lines x (track, column) positions. */
export interface Selection {
  anchor: { track: number; column: number; line: number };
  head: { track: number; column: number; line: number };
}

export interface UiState {
  currentPatternId: string;
  /** Selected entry in the order list (-1 when editing a pattern that is not in the song). */
  orderIndex: number;
  cursor: Cursor;
  selection: Selection | null;
  octave: number;
  editMode: boolean;
  editStep: number;
  selectedDeviceId: string | null;
  selectedSampleId: string | null;
  loop: boolean;
  follow: boolean;
  playing: boolean;
  playMode: 'song' | 'pattern';
  playTick: number;
  levels: number[];
  midiStatus: string;
  layout: Layout;
  message: string | null;
}

export interface AppState {
  project: Project;
  ui: UiState;
  past: Project[];
  future: Project[];
}

const HISTORY_LIMIT = 200;
const COALESCE_MS = 800;

type Listener = () => void;

class Store {
  private state: AppState;
  private listeners = new Set<Listener>();
  private lastCoalesce: { key: string; time: number } | null = null;
  private irCache: { project: Project; ir: IR } | null = null;
  private patternIrCache: { project: Project; patternId: string; ir: IR } | null = null;

  constructor(project: Project) {
    this.state = { project, ui: initialUi(project), past: [], future: [] };
  }

  getState = (): AppState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** The song IR for the current project (compiled on demand, cached by project identity). */
  songIR(): IR {
    const p = this.state.project;
    if (!this.irCache || this.irCache.project !== p) this.irCache = { project: p, ir: compileSong(p) };
    return this.irCache.ir;
  }

  /** IR of a single pattern, for "play pattern". */
  patternIR(patternId: string): IR {
    const p = this.state.project;
    const c = this.patternIrCache;
    if (!c || c.project !== p || c.patternId !== patternId) {
      this.patternIrCache = { project: p, patternId, ir: compileSong(p, { order: [patternId] }) };
    }
    return this.patternIrCache!.ir;
  }

  /**
   * Changes the project and records undo history. Changes with the same `coalesce` key in quick
   * succession (dragging a slider) become one undo step.
   */
  update(fn: (p: Project) => Project, coalesce?: string): void {
    const prev = this.state.project;
    const next = fn(prev);
    if (next === prev) return;
    const now = Date.now();
    const merge = coalesce && this.lastCoalesce && this.lastCoalesce.key === coalesce && now - this.lastCoalesce.time < COALESCE_MS;
    this.lastCoalesce = coalesce ? { key: coalesce, time: now } : null;
    const past = merge ? this.state.past : [...this.state.past, prev].slice(-HISTORY_LIMIT);
    this.state = { ...this.state, project: next, past, future: [] };
    this.state.ui = fixUi(this.state.ui, next);
    this.emit();
  }

  /** Replaces the whole project (load/new); clears history. */
  load(project: Project): void {
    this.state = { project, ui: { ...initialUi(project), octave: this.state.ui.octave, midiStatus: this.state.ui.midiStatus, layout: this.state.ui.layout }, past: [], future: [] };
    this.emit();
  }

  undo(): void {
    const { past, project, future } = this.state;
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    this.state = { ...this.state, project: prev, past: past.slice(0, -1), future: [project, ...future] };
    this.state.ui = fixUi(this.state.ui, prev);
    this.lastCoalesce = null;
    this.emit();
  }

  redo(): void {
    const { past, project, future } = this.state;
    if (future.length === 0) return;
    const next = future[0];
    this.state = { ...this.state, project: next, past: [...past, project], future: future.slice(1) };
    this.state.ui = fixUi(this.state.ui, next);
    this.lastCoalesce = null;
    this.emit();
  }

  setUi(patch: Partial<UiState> | ((ui: UiState) => Partial<UiState>)): void {
    const p = typeof patch === 'function' ? patch(this.state.ui) : patch;
    const ui = { ...this.state.ui, ...p };
    // Moving the cursor to another track selects that track's device, so the device highlighted
    // in the list is always the one live notes play. Playback following does not move the cursor,
    // so it never overrides a device the user picked.
    if (p.cursor && p.selectedDeviceId === undefined) {
      const old = this.state.ui;
      if (p.cursor.track !== old.cursor.track || ui.currentPatternId !== old.currentPatternId) {
        const deviceId = this.state.project.patterns.find((x) => x.id === ui.currentPatternId)?.tracks[ui.cursor.track]?.deviceId;
        if (deviceId) ui.selectedDeviceId = deviceId;
      }
    }
    this.state = { ...this.state, ui };
    this.emit();
  }
}

/** Changes part of the workbench layout (sidebars, panel, sizes). */
export function setLayout(patch: Partial<Layout> | ((l: Layout) => Partial<Layout>)): void {
  store.setUi((ui) => ({ layout: { ...ui.layout, ...(typeof patch === 'function' ? patch(ui.layout) : patch) } }));
}

/** The device live notes (MIDI, keyboard in play mode) play: the selected one, else the cursor track's. */
export function liveDeviceId(s: AppState): string | null {
  if (s.ui.selectedDeviceId && s.project.devices.some((d) => d.id === s.ui.selectedDeviceId)) return s.ui.selectedDeviceId;
  return currentPattern(s)?.tracks[s.ui.cursor.track]?.deviceId ?? null;
}

function initialUi(project: Project): UiState {
  const first = project.order[0] ?? project.patterns[0]?.id ?? '';
  return {
    currentPatternId: first,
    orderIndex: project.order.length > 0 ? 0 : -1,
    cursor: { track: 0, column: 0, field: 0, line: 0 },
    selection: null,
    octave: 4,
    editMode: true,
    editStep: 1,
    selectedDeviceId: project.devices[0]?.id ?? null,
    selectedSampleId: project.samples[0]?.id ?? null,
    loop: true,
    follow: true,
    playing: false,
    playMode: 'song',
    playTick: 0,
    levels: [0, 0, 0, 0, 0, 0, 0, 0],
    midiStatus: '',
    layout: loadLayout(),
    message: null,
  };
}

/** Keeps UI references valid after the project changed (deleted pattern, fewer tracks...). */
function fixUi(ui: UiState, p: Project): UiState {
  let { currentPatternId, orderIndex, cursor, selectedDeviceId, selectedSampleId } = ui;
  if (!p.patterns.some((x) => x.id === currentPatternId)) currentPatternId = p.patterns[0]?.id ?? '';
  if (orderIndex >= p.order.length) orderIndex = p.order.length - 1;
  if (orderIndex >= 0 && p.order[orderIndex] !== currentPatternId) {
    const i = p.order.indexOf(currentPatternId);
    orderIndex = i;
  }
  const pattern = p.patterns.find((x) => x.id === currentPatternId);
  if (pattern) {
    const track = Math.min(cursor.track, Math.max(0, pattern.tracks.length - 1));
    const column = Math.min(cursor.column, Math.max(0, (pattern.tracks[track]?.noteColumns ?? 1) - 1));
    const line = Math.min(cursor.line, pattern.lines - 1);
    if (track !== cursor.track || column !== cursor.column || line !== cursor.line) cursor = { ...cursor, track, column, line };
  }
  if (selectedDeviceId && !p.devices.some((d) => d.id === selectedDeviceId)) selectedDeviceId = p.devices[0]?.id ?? null;
  if (selectedSampleId && !p.samples.some((s) => s.id === selectedSampleId)) selectedSampleId = p.samples[0]?.id ?? null;
  return { ...ui, currentPatternId, orderIndex, cursor, selectedDeviceId, selectedSampleId };
}

export let store: Store;

export function initStore(project: Project): Store {
  store = new Store(project);
  return store;
}

/** Subscribes a component to a slice of the state; re-renders only when the slice changes. */
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

// ------------------------------------------------------------ immutable update helpers

export function updatePattern(p: Project, patternId: string, fn: (pat: Pattern) => Pattern): Project {
  return { ...p, patterns: p.patterns.map((x) => (x.id === patternId ? fn(x) : x)) };
}

/** Returns a copy of the pattern whose cell rows can be mutated safely. */
export function clonePatternCells(pat: Pattern): Pattern {
  return { ...pat, tracks: pat.tracks.map((t) => ({ ...t, cells: t.cells.map((row) => row.slice()) })) };
}

export function setCell(p: Project, patternId: string, track: number, line: number, column: number, fn: (c: Cell | null) => Cell | null): Project {
  return updatePattern(p, patternId, (pat) => {
    const t = pat.tracks[track];
    if (!t || line >= pat.lines || column >= t.noteColumns) return pat;
    const old = t.cells[line]?.[column] ?? null;
    let next = fn(old ? { ...old } : null);
    if (next && Object.values(next).every((v) => v === undefined)) next = null;
    const cells = t.cells.slice();
    const row = (cells[line] ?? []).slice();
    row[column] = next;
    cells[line] = row;
    const tracks = pat.tracks.slice();
    tracks[track] = { ...t, cells };
    return { ...pat, tracks };
  });
}

export function currentPattern(s: AppState): Pattern | undefined {
  return s.project.patterns.find((p) => p.id === s.ui.currentPatternId);
}
