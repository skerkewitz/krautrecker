import { useEffect } from 'react';
import { engine } from '../audio/engine';
import { saveAutosave } from '../io/autosave';
import { startMidi } from '../midi/midi';
import { auditionOff, auditionOn, stop, syncEngine, togglePlay } from './actions';
import { AramMeter, Diagnostics, OrderList, VoiceMeter } from './BottomPanels';
import { DevicePanel } from './DevicePanel';
import { HardwarePanel } from './HardwarePanel';
import { IRView } from './IRView';
import { enterNote } from './patternEdit';
import { PatternEditor } from './PatternEditor';
import { SamplePanel } from './SamplePanel';
import { Field, store, useStore } from './store';
import { Toolbar } from './Toolbar';
import './App.css';

function isTextInput(el: EventTarget | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
}

export function App() {
  const tab = useStore((s) => s.ui.leftTab);
  const message = useStore((s) => s.ui.message);

  useEffect(() => {
    // Global shortcuts that work outside the pattern editor too.
    const onKey = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return;
      const ctrl = e.ctrlKey || e.metaKey;
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
    let lastProject = store.getState().project;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const unsub = store.subscribe(() => {
      const p = store.getState().project;
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
      <div className="main">
        <aside className="left">
          <div className="tabs">
            {(['devices', 'samples', 'hardware'] as const).map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => store.setUi({ leftTab: t })}>
                {t === 'devices' ? 'Devices' : t === 'samples' ? 'Samples' : 'Hardware'}
              </button>
            ))}
          </div>
          {tab === 'devices' && <DevicePanel />}
          {tab === 'samples' && <SamplePanel />}
          {tab === 'hardware' && <HardwarePanel />}
        </aside>
        <section className="center">
          <PatternEditor />
        </section>
        <section className="right">
          <IRView />
        </section>
      </div>
      <div className="bottom">
        <OrderList />
        <VoiceMeter />
        <AramMeter />
        <Diagnostics />
      </div>
      <HelpLine />
      {message && (
        <div className="toast" onClick={() => store.setUi({ message: null })}>
          {message}
        </div>
      )}
    </div>
  );
}

function HelpLine() {
  return (
    <div className="helpline">
      <b>Keys</b> Z–M / Q–P: notes (FT2 layout) · 1: note off · ^/`: cut · Del: clear · Ins/Backspace: shift lines · Tab: next track · Shift+arrows: select ·
      Ctrl+C/X/V: copy/cut/paste · Esc: edit mode · Space: play/stop · Shift+Space: pattern · Enter: from cursor · Num +/−: octave · fx letters: U D P V A C R
    </div>
  );
}
