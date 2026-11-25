import { useEffect, useRef, useState } from 'react';
import { keyName, pitchClassName } from '../model/harmony';
import { noteName } from '../model/notes';
import type { Mode, MusicalKey, Pattern } from '../model/types';
import { chordInForce, commentsAt, MODE_NAMES, noteHarmony, setPatternKey, setSongKey } from './harmonyEdit';
import { Field, store, updatePattern, useStore } from './store';

/**
 * Pattern bar pieces for harmony: the key picker, what the note under the cursor is in the key and
 * chord in force, and the comment at the cursor.
 */

/** A button naming the key in force; it opens a small popover to set the song and pattern key. */
export function KeyPicker({ pattern }: { pattern: Pattern }) {
  const songKey = useStore((s) => s.project.key);
  const [open, setOpen] = useState(false);
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

  const inForce = pattern.key ?? songKey;
  const source = pattern.key ? 'this pattern' : 'the song';
  return (
    <div className="key-picker" ref={ref}>
      <button
        className={open ? 'active' : ''}
        title={inForce ? `Key in force: ${keyName(inForce)}, set by ${source}. Click to change.` : 'No key set. Click to set the song or pattern key.'}
        onClick={() => setOpen(!open)}
      >
        Key <b>{inForce ? keyName(inForce) : '—'}</b>
        {pattern.key && <span className="dim"> (pattern)</span>}
      </button>
      {open && (
        <div className="key-pop">
          <KeyRow label="Song" value={songKey} none="none" onChange={(k) => store.update((p) => setSongKey(p, k))} />
          <KeyRow
            label="Pattern"
            value={pattern.key}
            none={songKey ? `= song (${keyName(songKey)})` : '= song (none)'}
            defaultMode={songKey?.mode}
            onChange={(k) => store.update((p) => updatePattern(p, pattern.id, (pat) => setPatternKey(pat, k)))}
          />
          <div className="dim">Keys and chords state your intent; they never change the sound.</div>
        </div>
      )}
    </div>
  );
}

function KeyRow(props: { label: string; value: MusicalKey | null; none: string; defaultMode?: Mode; onChange: (k: MusicalKey | null) => void }) {
  const { label, value, none, defaultMode, onChange } = props;
  return (
    <label>
      <span>{label}</span>
      <select
        value={value ? String(value.root) : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : { root: Number(e.target.value), mode: value?.mode ?? defaultMode ?? 'major' })}
      >
        <option value="">{none}</option>
        {Array.from({ length: 12 }, (_, pc) => (
          <option key={pc} value={pc}>
            {pitchClassName(pc)}
          </option>
        ))}
      </select>
      <select value={value?.mode ?? ''} disabled={!value} onChange={(e) => value && onChange({ root: value.root, mode: e.target.value as Mode })}>
        {!value && <option value="">—</option>}
        {MODE_NAMES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The note under the cursor: its name, its scale degree in the key in force and how it relates to
 * the chord in force. It uses the sounding pitch, after the track's transpose.
 */
export function NoteInfo({ pattern }: { pattern: Pattern }) {
  const project = useStore((s) => s.project);
  const cursor = useStore((s) => s.ui.cursor);
  const orderIndex = useStore((s) => s.ui.orderIndex);
  if (cursor.field !== Field.Note) return null;
  const track = pattern.tracks[cursor.track];
  const note = track?.cells[cursor.line]?.[cursor.column]?.note;
  if (!track || typeof note !== 'number') return null;
  const sounding = note + track.transpose;
  const name = (
    <>
      <b>{noteName(note)}</b>
      {track.transpose !== 0 && <span className="dim"> sounds {noteName(sounding)}</span>}
    </>
  );
  // On a drum track the pitch picks a drum, so degrees would mean nothing.
  if (project.devices.find((d) => d.id === track.deviceId)?.mode === 'drum') {
    return (
      <span className="fx-help note-info">
        {name} <span className="dim">· drum</span>
      </span>
    );
  }
  const key = pattern.key ?? project.key;
  const h = noteHarmony(sounding, key, chordInForce(project, pattern, orderIndex, cursor.line));
  const chord = h.chord;
  return (
    <span className="fx-help note-info">
      {name}
      {key ? (
        <>
          {' · degree '}
          <b className={h.inKey ? '' : 'warn'} title={h.inKey ? 'In the key' : 'Outside the key'}>
            {h.degree}
          </b>
          <span className="dim"> of {keyName(key)}</span>
        </>
      ) : (
        <span className="dim"> · no key</span>
      )}
      {chord &&
        (chord.valid ? (
          <>
            {` · ${chord.symbol}: `}
            {chord.chordTone ? (
              <span className="good">chord tone ({chord.interval === 'R' ? 'root' : chord.interval})</span>
            ) : (
              <span className="warn">{chord.interval}, not in the chord</span>
            )}
          </>
        ) : (
          <span className="bad"> · {chord.symbol}: unknown chord</span>
        ))}
    </span>
  );
}

/** The comments at the cursor's cell and line, so moving the cursor onto a mark shows its text. */
export function CursorComment({ pattern }: { pattern: Pattern }) {
  const cursor = useStore((s) => s.ui.cursor);
  const list = [...commentsAt(pattern, cursor.line, cursor.track), ...commentsAt(pattern, cursor.line, null)];
  if (list.length === 0) return null;
  const text = list.map((c) => c.text).join(' · ');
  return (
    <span className="cursor-comment" title={`${text}\n(Ctrl+M edits the cell comment, Ctrl+Alt+M the line comment)`}>
      {text}
    </span>
  );
}
