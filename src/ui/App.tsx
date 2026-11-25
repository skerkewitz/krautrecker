import { useEffect } from 'react';
import { engine } from '../audio/engine';
import { saveAutosave } from '../io/autosave';
import { startMidi } from '../midi/midi';
import { auditionOff, auditionOn, stop, syncEngine, togglePlay } from './actions';
import { IRView } from './IRView';
import { saveLayout } from './layout';
import { enterNote } from './patternEdit';
import { PatternEditor } from './PatternEditor';
import { Field, setLayout, store, useStore } from './store';
import { Toolbar } from './Toolbar';
import { ActivityBar, BottomPanel, LeftSidebar, Sash, StatusBar } from './Workbench';
import './App.css';

function isTextInput(el: EventTarget | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
}

export function App() {
  const layout = useStore((s) => s.ui.layout);
  const message = useStore((s) => s.ui.message);

  useEffect(() => {
    // Global shortcuts that work outside the pattern editor too.
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      // Layout toggles work everywhere, as in VS Code.
      if (ctrl && e.code === 'KeyB') {
        setLayout((l) => (e.altKey ? { rightOpen: !l.rightOpen } : { leftOpen: !l.leftOpen }));
        e.preventDefault();
        return;
      }
      if (ctrl && e.code === 'KeyJ') {
        setLayout((l) => ({ bottomOpen: !l.bottomOpen }));
        e.preventDefault();
        return;
      }
      if (isTextInput(e.target)) return;
      if (ctrl && e.code === 'KeyZ' && !e.shiftKey) {
        store.undo();
        e.preventDefault();
      } else if (ctrl && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) {
        store.redo();
        e.preventDefault();
      } else if (e.code === 'Space' && !(e.target instanceof HTMLCanvasElement)) {
        togglePlay();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);

    // Playback position from the worklet; with "follow" the editor tracks the playing pattern.
    const offPos = engine.onPosition((p) => {
      const s = store.getState();
      const patch: Parameters<typeof store.setUi>[0] = { playTick: p.tick, levels: p.levels };
      if (!p.playing && s.ui.playing) patch.playing = false;
      if (p.playing && s.ui.playing && s.ui.follow && s.ui.playMode === 'song') {
        const info = store.songIR().lines[Math.floor(p.tick / s.project.timing.ticksPerLine)];
        if (info && (info.orderIndex !== s.ui.orderIndex || info.patternId !== s.ui.currentPatternId)) {
          patch.orderIndex = info.orderIndex;
          patch.currentPatternId = info.patternId;
        }
      }
      store.setUi(patch);
    });

    // Every project change: push samples and the fresh IR to the player, and autosave.
    // Layout changes are remembered as a preference, separately from the project.
    let lastProject = store.getState().project;
    let lastLayout = store.getState().ui.layout;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const unsub = store.subscribe(() => {
      const { project: p, ui } = store.getState();
      if (ui.layout !== lastLayout) {
        lastLayout = ui.layout;
        saveLayout(ui.layout);
      }
      if (p === lastProject) return;
      lastProject = p;
      syncEngine();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void saveAutosave(p).catch((e) => console.warn('Autosave failed', e)), 1000);
    });

    void startMidi({
      noteOn: (note, velocity) => {
        auditionOn(`midi:${note}`, note, velocity);
        const s = store.getState();
        if (s.ui.editMode && s.ui.cursor.field === Field.Note) enterNote(note);
      },
      noteOff: (note) => auditionOff(`midi:${note}`),
      status: (text) => store.setUi({ midiStatus: text }),
    });

    return () => {
      window.removeEventListener('keydown', onKey);
      offPos();
      unsub();
      stop();
    };
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => store.setUi({ message: null }), 6000);
    return () => clearTimeout(t);
  }, [message]);

  return (
    <div className="app">
      <Toolbar />
      <div className="workbench">
        <ActivityBar />
        {layout.leftOpen && (
          <>
            <div style={{ width: layout.leftWidth }} className="sidebar-slot">
              <LeftSidebar />
            </div>
            <Sash side="left" />
          </>
        )}
        <div className="editor-column">
          <section className="editor-area">
            <PatternEditor />
          </section>
          {layout.bottomOpen && (
            <>
              <Sash side="bottom" />
              <div style={{ height: layout.bottomHeight }} className="panel-slot">
                <BottomPanel />
              </div>
            </>
          )}
        </div>
        {layout.rightOpen && (
          <>
            <Sash side="right" />
            <aside style={{ width: layout.rightWidth }} className="sidebar right">
              <IRView />
            </aside>
          </>
        )}
      </div>
      <StatusBar />
      {message && (
        <div className="toast" onClick={() => store.setUi({ message: null })}>
          {message}
        </div>
      )}
    </div>
  );
}
