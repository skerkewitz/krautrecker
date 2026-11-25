import { useRef } from 'react';
import { downloadProject, parseProject } from '../io/projectFile';
import { demoProject } from '../model/demo';
import { emptyProject } from '../model/defaults';
import { playFromCursor, playPattern, playSong, stop } from './actions';
import { store, useStore } from './store';
import { NumberInput } from './widgets';

export function Toolbar() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const fileRef = useRef<HTMLInputElement>(null);
  const setTiming = (patch: Partial<typeof project.timing>, key: string) => store.update((p) => ({ ...p, timing: { ...p.timing, ...patch } }), key);

  const open = async (files: FileList | null) => {
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
  const replace = (make: () => ReturnType<typeof emptyProject>, what: string) => {
    if (!confirm(`Replace the current project with ${what}? Save it first if you want to keep it.`)) return;
    stop();
    store.load(make());
  };

  return (
    <div className="toolbar">
      <div className="brand" title="SNES music tracker">
        Krautrecker
      </div>
      <input className="title" value={project.title} onChange={(e) => store.update((p) => ({ ...p, title: e.target.value }), 'title')} title="Song title" />
      <div className="group transport">
        <button className={ui.playing && ui.playMode === 'song' ? 'on' : ''} onClick={() => void playSong(0)} title="Play song (Space)">
          ▶ Song
        </button>
        <button className={ui.playing && ui.playMode === 'pattern' ? 'on' : ''} onClick={() => void playPattern(0)} title="Play pattern, looped (Shift+Space)">
          ▶ Pattern
        </button>
        <button onClick={() => void playFromCursor()} title="Play from the cursor line (Enter)">
          ▶ Cursor
        </button>
        <button onClick={stop} title="Stop (Space)">
          ■
        </button>
        <label title="Loop the song">
          <input type="checkbox" checked={ui.loop} onChange={(e) => store.setUi({ loop: e.target.checked })} /> loop
        </label>
        <label title="Scroll the editor with the play position">
          <input type="checkbox" checked={ui.follow} onChange={(e) => store.setUi({ follow: e.target.checked })} /> follow
        </label>
      </div>
      <div className="group">
        <label title="Beats per minute">
          BPM <NumberInput value={project.timing.bpm} min={32} max={300} onChange={(v) => setTiming({ bpm: v }, 'bpm')} width={52} />
        </label>
        <label title="Lines per beat">
          LPB <NumberInput value={project.timing.linesPerBeat} min={1} max={16} onChange={(v) => setTiming({ linesPerBeat: v }, 'lpb')} width={40} />
        </label>
        <label title="Ticks per line: the time resolution of effects, arps and note delay">
          TPL <NumberInput value={project.timing.ticksPerLine} min={1} max={16} onChange={(v) => setTiming({ ticksPerLine: v }, 'tpl')} width={40} />
        </label>
      </div>
      <div className="group">
        <label title="Keyboard octave (Numpad +/−)">
          Oct <NumberInput value={ui.octave} min={0} max={8} onChange={(v) => store.setUi({ octave: v })} width={40} />
        </label>
        <label title="Lines the cursor moves after each entry">
          Step <NumberInput value={ui.editStep} min={0} max={16} onChange={(v) => store.setUi({ editStep: v })} width={40} />
        </label>
        <button className={ui.editMode ? 'on rec' : ''} onClick={() => store.setUi({ editMode: !ui.editMode })} title="Edit mode (Esc): keys write notes. Off: keys only play.">
          ● Edit
        </button>
      </div>
      <div className="group">
        <button disabled={!canUndo} onClick={() => store.undo()} title="Undo (Ctrl+Z)">
          ↶
        </button>
        <button disabled={!canRedo} onClick={() => store.redo()} title="Redo (Ctrl+Y)">
          ↷
        </button>
      </div>
      <div className="group">
        <button onClick={() => downloadProject(store.getState().project)} title="Download the project as a .json file">
          Save
        </button>
        <button onClick={() => fileRef.current?.click()} title="Open a project .json file">
          Open
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void open(e.target.files)} />
        <button onClick={() => replace(emptyProject, 'an empty project')}>New</button>
        <button onClick={() => replace(demoProject, 'the demo song')}>Demo</button>
      </div>
      <div className="midi dim" title="Web MIDI input status">
        {ui.midiStatus}
      </div>
    </div>
  );
}
