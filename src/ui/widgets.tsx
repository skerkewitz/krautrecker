import type { ReactNode } from 'react';
import { noteName } from '../model/notes';

/** Small form controls shared by the editor panels. */

export function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <label className="row" title={title}>
      <span className="row-label">{label}</span>
      {children}
    </label>
  );
}

export function NumberInput({ value, min, max, step = 1, onChange, width = 64 }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; width?: number }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      style={{ width }}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
      }}
    />
  );
}

export function Slider({ value, min, max, step = 1, onChange, format }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <span className="slider">
      <input type="range" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-value">{format ? format(value) : value}</span>
    </span>
  );
}

/** MIDI note input showing the note name next to the number. */
export function NoteInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span className="note-input">
      <NumberInput value={value} min={0} max={127} onChange={onChange} width={52} />
      <span className="dim">{noteName(value)}</span>
    </span>
  );
}
