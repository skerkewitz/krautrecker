import { useEffect, useState } from 'react';
import { describeGain, formatSeconds, releaseSeconds } from '../compiler/envelope';
import { hex } from '../model/notes';
import type { Device, Release } from '../model/types';
import { Row, Slider } from './widgets';

/** Device editor sections for release, the advanced GAIN envelope and tremolo. */

type SetDevice = (patch: Partial<Device>, key: string) => void;

const RELEASE_MODES: { value: Release['mode']; label: string }[] = [
  { value: 'hardware', label: 'Hardware key-off (8 ms)' },
  { value: 'exp', label: 'Exponential (GAIN)' },
  { value: 'linear', label: 'Linear (GAIN)' },
];

export function ReleaseSection({ device, set }: { device: Device; set: SetDevice }) {
  const rel = device.release;
  const setRel = (patch: Partial<Release>) => set({ release: { ...rel, ...patch } }, 'rel');
  return (
    <fieldset>
      <legend>Release</legend>
      <Row label="Mode" title="Key-off always releases in about 8 ms. Longer releases switch the voice to a GAIN decrease at note-off and key it off once it is silent. CUT and the cut effect stay hard cuts.">
        <select value={rel.mode} onChange={(e) => setRel({ mode: e.target.value as Release['mode'] })}>
          {RELEASE_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Row>
      {rel.mode !== 'hardware' && (
        <Row label="Rate" title="GAIN rate (higher = faster). The time is from full level to silence; the voice stays busy that long.">
          <Slider value={rel.rate} min={1} max={31} onChange={(v) => setRel({ rate: v })} format={(v) => `${v}: ${formatSeconds(releaseSeconds({ ...rel, rate: v }))}`} />
        </Row>
      )}
    </fieldset>
  );
}

const GAIN_MODES = [
  { base: 0x00, label: 'Direct level' },
  { base: 0x80, label: 'Linear decrease' },
  { base: 0xa0, label: 'Exponential decrease' },
  { base: 0xc0, label: 'Linear increase' },
  { base: 0xe0, label: 'Bent-line increase' },
];

function gainBase(b: number): number {
  return b < 0x80 ? 0x00 : b & 0xe0;
}

/** Two hex digits, edited as text so a half-typed value does not jump around. */
function HexByteInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(hex(value, 2));
  useEffect(() => setText(hex(value, 2)), [value]);
  return (
    <input
      value={text}
      maxLength={2}
      style={{ width: 40, fontFamily: 'monospace' }}
      onChange={(e) => {
        setText(e.target.value);
        if (/^[0-9a-f]{1,2}$/i.test(e.target.value)) onChange(parseInt(e.target.value, 16));
      }}
      onBlur={() => setText(hex(value, 2))}
    />
  );
}

/** A new GAIN byte for another mode: full level for direct, otherwise keep the rate (16 from direct). */
function switchMode(from: number, to: number, amount: number): number {
  if (to === 0) return 0x7f;
  return to | (from === 0 ? 16 : amount);
}

export function GainSection({ device, set }: { device: Device; set: SetDevice }) {
  const g = device.gain;
  const setGain = (v: number | null) => set({ gain: v }, 'gain');
  const base = g === null ? 0 : gainBase(g);
  const amount = g === null ? 0 : base === 0 ? g & 0x7f : g & 0x1f;
  return (
    <fieldset>
      <legend>
        <input type="checkbox" checked={g !== null} onChange={(e) => setGain(e.target.checked ? 0x7f : null)} /> Advanced: GAIN envelope
      </legend>
      {g !== null && (
        <>
          <div className="dim small">Notes key on with this raw GAIN byte instead of the ADSR envelope above.</div>
          <Row label="GAIN byte">
            <HexByteInput value={g} onChange={setGain} />
          </Row>
          <Row label="Mode">
            <select value={base} onChange={(e) => setGain(switchMode(base, Number(e.target.value), amount))}>
              {GAIN_MODES.map((m) => (
                <option key={m.base} value={m.base}>
                  {m.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label={base === 0 ? 'Level' : 'Rate'}>
            <Slider value={amount} min={0} max={base === 0 ? 127 : 31} onChange={(v) => setGain(base | v)} />
          </Row>
          <div className="dim small">{describeGain(g)}</div>
        </>
      )}
    </fieldset>
  );
}

export function TremoloSection({ device, set }: { device: Device; set: SetDevice }) {
  const t = device.tremolo;
  return (
    <fieldset>
      <legend>
        <input type="checkbox" checked={!!t} onChange={(e) => set({ tremolo: e.target.checked ? { depth: 32, rate: 12, delay: 0 } : null }, 'trem')} /> Tremolo
      </legend>
      {t && (
        <>
          <Row label="Depth" title="How far the volume dips below full volume at the trough. Quieter notes dip proportionally.">
            <Slider value={t.depth} min={0} max={127} onChange={(v) => set({ tremolo: { ...t, depth: v } }, 'tremd')} />
          </Row>
          <Row label="Period">
            <Slider value={t.rate} min={2} max={96} onChange={(v) => set({ tremolo: { ...t, rate: v } }, 'tremr')} format={(v) => `${v} ticks`} />
          </Row>
          <Row label="Delay">
            <Slider value={t.delay} min={0} max={96} onChange={(v) => set({ tremolo: { ...t, delay: v } }, 'tremdl')} format={(v) => `${v} ticks`} />
          </Row>
        </>
      )}
    </fieldset>
  );
}
