import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { downloadProject, parseProject } from '../io/projectFile';
import { emptyProject } from '../model/defaults';
import { demoProject } from '../model/demoSong';
import type { Project } from '../model/types';
import { stop } from './actions';
import { AramMeter, Diagnostics, OrderList, VoiceMeter } from './BottomPanels';
import { DevicePanel } from './DevicePanel';
import { HardwarePanel } from './HardwarePanel';
import { CloseIcon, DevicesIcon, HardwareIcon, MenuIcon, SamplesIcon, SongIcon } from './icons';
import { clampSize, DEFAULT_LAYOUT, LIMITS, type BottomTab, type LeftView } from './layout';
import { SamplePanel } from './SamplePanel';
import { setLayout, store, useStore } from './store';

// ------------------------------------------------------------------ activity bar

const VIEWS: { id: LeftView; title: string; icon: () => ReactNode }[] = [
  { id: 'devices', title: 'Devices', icon: DevicesIcon },
  { id: 'samples', title: 'Samples', icon: SamplesIcon },
  { id: 'song', title: 'Song', icon: SongIcon },
  { id: 'hardware', title: 'Hardware', icon: HardwareIcon },
];

/** Clicking a view's icon shows it; clicking the active view's icon hides the sidebar (as in VS Code). */
export function showView(view: LeftView): void {
  setLayout((l) => (l.leftOpen && l.leftView === view ? { leftOpen: false } : { leftOpen: true, leftView: view }));
}

export function ActivityBar() {
  const layout = useStore((s) => s.ui.layout);
  return (
    <nav className="activity-bar">
      <MainMenu />
      {VIEWS.map((v) => (
        <button
          key={v.id}
          className={`activity${layout.leftOpen && layout.leftView === v.id ? ' active' : ''}`}
          title={v.title}
          aria-label={v.title}
          onClick={() => showView(v.id)}
        >
          <v.icon />
        </button>
      ))}
    </nav>
  );
}

// ------------------------------------------------------------------ main menu

function MainMenu() {
  const [open, setOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const fileRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const replace = (make: () => Project, what: string) => {
    if (!confirm(`Replace the current project with ${what}? Save it first if you want to keep it.`)) return;
    stop();
    store.load(make());
  };
  const openFile = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    try {
      stop();
      store.load(parseProject(await f.text()));
    } catch (e) {
      store.setUi({ message: `Could not open ${f.name}: ${(e as Error).message}` });
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="main-menu" ref={ref}>
      <button className={`activity${open ? ' active' : ''}`} title="Menu" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MenuIcon />
      </button>
      {open && (
        <div className="menu" role="menu">
          <MenuItem label="New project" onClick={run(() => replace(emptyProject, 'an empty project'))} />
          <MenuItem label="Open…" onClick={run(() => fileRef.current?.click())} />
          <MenuItem label="Save" hint="downloads .json" onClick={run(() => downloadProject(store.getState().project))} />
          <MenuItem label="Load demo song" onClick={run(() => replace(demoProject, 'the demo song'))} />
          <div className="menu-sep" />
          <MenuItem label="Undo" hint="Ctrl+Z" disabled={!canUndo} onClick={run(() => store.undo())} />
          <MenuItem label="Redo" hint="Ctrl+Y" disabled={!canRedo} onClick={run(() => store.redo())} />
          <div className="menu-sep" />
          <MenuItem label="Toggle left sidebar" hint="Ctrl+B" onClick={run(() => setLayout((l) => ({ leftOpen: !l.leftOpen })))} />
          <MenuItem label="Toggle panel" hint="Ctrl+J" onClick={run(() => setLayout((l) => ({ bottomOpen: !l.bottomOpen })))} />
          <MenuItem label="Toggle IR view" hint="Ctrl+Alt+B" onClick={run(() => setLayout((l) => ({ rightOpen: !l.rightOpen })))} />
          <div className="menu-sep" />
          <MenuItem label="Keyboard shortcuts" onClick={run(() => setShortcuts(true))} />
        </div>
      )}
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void openFile(e.target.files)} />
      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}
    </div>
  );
}

function MenuItem({ label, hint, disabled, onClick }: { label: string; hint?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="menu-item" role="menuitem" disabled={disabled} onClick={onClick}>
      <span>{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Z … M, Q … P', 'Enter a note (FT2 piano layout, by key position)'],
  ['1', 'Note off'],
  ['^ (key left of 1)', 'Note cut'],
  ['Num + / Num −', 'Octave up / down'],
  ['Esc', 'Toggle edit mode (off: keys only play the device)'],
  ['Delete', 'Clear the field or selection'],
  ['Insert / Backspace', 'Insert a line / delete the line above'],
  ['Tab / Shift+Tab', 'Next / previous track'],
  ['Shift+arrows, drag', 'Select'],
  ['Ctrl+C / X / V', 'Copy / cut / paste'],
  ['Ctrl+A', 'Select the whole track'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['Space', 'Play song / stop'],
  ['Shift+Space', 'Play pattern (looped)'],
  ['Enter', 'Play from the cursor'],
  ['Ctrl+B / Ctrl+J / Ctrl+Alt+B', 'Toggle left sidebar / panel / IR view'],
  ['U D P V T A L C R G N', 'Note effects: slide up/down, porta, vibrato, tremolo, volume/pan slide, cut, retrigger, GAIN, noise'],
  ['M K X', 'Track effects: volume, volume slide, pan (until the pattern ends)'],
  ['F W H E Y B Z', 'Global effects: tempo, main volume (slide), echo volume (slide), echo feedback, echo write'],
  ['00 after U D P V T A L R K H Y', 'Repeat the last value of that effect in the column (V, T: per digit)'],
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-label="Keyboard shortcuts" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          Keyboard shortcuts
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <table className="shortcuts">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ left sidebar

export function LeftSidebar() {
  const view = useStore((s) => s.ui.layout.leftView);
  const title = VIEWS.find((v) => v.id === view)!.title;
  return (
    <aside className="sidebar left">
      <div className="sidebar-title">{title}</div>
      {view === 'devices' && <DevicePanel />}
      {view === 'samples' && <SamplePanel />}
      {view === 'song' && <OrderList />}
      {view === 'hardware' && <HardwarePanel />}
    </aside>
  );
}

// ------------------------------------------------------------------ bottom panel

const TABS: { id: BottomTab; title: string }[] = [
  { id: 'voices', title: 'Voices' },
  { id: 'aram', title: 'ARAM' },
  { id: 'diagnostics', title: 'Diagnostics' },
];

export function BottomPanel() {
  const tab = useStore((s) => s.ui.layout.bottomTab);
  const project = useStore((s) => s.project);
  const problems = useMemo(() => store.songIR().diagnostics.filter((d) => d.severity !== 'info').length, [project]);
  return (
    <section className="bottom-panel">
      <div className="panel-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`panel-tab${t.id === tab ? ' active' : ''}`} onClick={() => setLayout({ bottomTab: t.id })}>
            {t.title}
            {t.id === 'diagnostics' && problems > 0 && <span className="badge">{problems}</span>}
          </button>
        ))}
        <button className="icon-button panel-close" title="Hide panel (Ctrl+J)" aria-label="Hide panel" onClick={() => setLayout({ bottomOpen: false })}>
          <CloseIcon />
        </button>
      </div>
      <div className="panel-body">
        {tab === 'voices' && <VoiceMeter />}
        {tab === 'aram' && <AramMeter />}
        {tab === 'diagnostics' && <Diagnostics />}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ status bar

export function StatusBar() {
  const project = useStore((s) => s.project);
  const midi = useStore((s) => s.ui.midiStatus);
  const ir = useMemo(() => store.songIR(), [project]);
  const available = 8 - ir.reservedVoices.length;
  const peak = ir.voiceUsage.reduce((m, u) => Math.max(m, u.demand), 0);
  const errors = ir.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = ir.diagnostics.filter((d) => d.severity === 'warning').length;
  const open = (bottomTab: BottomTab) => setLayout({ bottomOpen: true, bottomTab });
  return (
    <footer className="status-bar">
      <button className={peak > available ? 'bad' : ''} onClick={() => open('voices')} title="Peak voice demand / voices available">
        Voices {peak}/{available}
      </button>
      <button className={ir.aram.total > ir.aram.capacity ? 'bad' : ''} onClick={() => open('aram')} title="ARAM estimate">
        ARAM {(ir.aram.total / 1024).toFixed(1)} / 64 KB
      </button>
      <button onClick={() => open('diagnostics')} title="Errors and warnings">
        <span className={errors ? 'bad' : ''}>⨯ {errors}</span> <span className={warnings ? 'warn' : ''}>⚠ {warnings}</span>
      </button>
      <span className="status-right">{midi}</span>
    </footer>
  );
}

// ------------------------------------------------------------------ resize handle

/**
 * A draggable edge between two areas. `side` says which area it resizes: the left sidebar grows to
 * the right, the right sidebar to the left, and the bottom panel upwards. Double-click resets it.
 */
export function Sash({ side }: { side: 'left' | 'right' | 'bottom' }) {
  const key = side === 'left' ? 'leftWidth' : side === 'right' ? 'rightWidth' : 'bottomHeight';
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const start = side === 'bottom' ? e.clientY : e.clientX;
    const startSize = store.getState().ui.layout[key];
    const move = (ev: PointerEvent) => {
      const pos = side === 'bottom' ? ev.clientY : ev.clientX;
      const delta = side === 'left' ? pos - start : start - pos;
      setLayout({ [key]: clampSize(key, startSize + delta) });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const [lo, hi] = LIMITS[key];
  return (
    <div
      className={`sash sash-${side}`}
      role="separator"
      aria-orientation={side === 'bottom' ? 'horizontal' : 'vertical'}
      aria-valuemin={lo}
      aria-valuemax={hi}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setLayout({ [key]: DEFAULT_LAYOUT[key] })}
    />
  );
}
