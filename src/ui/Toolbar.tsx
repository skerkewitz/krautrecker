import { playFromCursor, playPattern, playSong, stop } from './actions';
import { LayoutIcon } from './icons';
import { setLayout, store, useStore } from './store';
import { NumberInput } from './widgets';

/** The top bar: song title, transport, timing and entry settings, and the layout toggles. */
export function Toolbar() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const layout = ui.layout;
  const setTiming = (patch: Partial<typeof project.timing>, key: string) => store.update((p) => ({ ...p, timing: { ...p.timing, ...patch } }), key);

  return (
    <header className="toolbar">
      <div className="brand" title="SNES music tracker">
        Krautrecker
      </div>
      <input className="title" value={project.title} onChange={(e) => store.update((p) => ({ ...p, title: e.target.value }), 'title')} title="Song title" aria-label="Song title" />
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
        <button onClick={stop} title="Stop (Space)" aria-label="Stop">
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
        <label title="Keyboard octave (Num +/−)">
          Oct <NumberInput value={ui.octave} min={0} max={8} onChange={(v) => store.setUi({ octave: v })} width={40} />
        </label>
        <label title="Lines the cursor moves after each entry">
          Step <NumberInput value={ui.editStep} min={0} max={16} onChange={(v) => store.setUi({ editStep: v })} width={40} />
        </label>
        <button className={ui.editMode ? 'on rec' : ''} onClick={() => store.setUi({ editMode: !ui.editMode })} title="Edit mode (Esc): keys write notes. Off: keys only play the device.">
          ● Edit
        </button>
      </div>
      <div className="group layout-toggles">
        <button className="icon-button" title="Toggle left sidebar (Ctrl+B)" aria-label="Toggle left sidebar" aria-pressed={layout.leftOpen} onClick={() => setLayout({ leftOpen: !layout.leftOpen })}>
          <LayoutIcon part="left" on={layout.leftOpen} />
        </button>
        <button className="icon-button" title="Toggle panel (Ctrl+J)" aria-label="Toggle panel" aria-pressed={layout.bottomOpen} onClick={() => setLayout({ bottomOpen: !layout.bottomOpen })}>
          <LayoutIcon part="bottom" on={layout.bottomOpen} />
        </button>
        <button className="icon-button" title="Toggle IR view (Ctrl+Alt+B)" aria-label="Toggle IR view" aria-pressed={layout.rightOpen} onClick={() => setLayout({ rightOpen: !layout.rightOpen })}>
          <LayoutIcon part="right" on={layout.rightOpen} />
        </button>
      </div>
    </header>
  );
}
