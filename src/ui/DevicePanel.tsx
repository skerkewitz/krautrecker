import { formatNoiseRate } from '../compiler/chip';
import { newDevice, newZone } from '../model/defaults';
import type { ArpDirection, Device, DeviceMode, Envelope, Zone } from '../model/types';
import { newId } from '../util/base64';
import { auditionOff, auditionOn } from './actions';
import { GainSection, ReleaseSection, TremoloSection } from './EnvelopeSections';
import { store, useStore } from './store';
import { NoteInput, NumberInput, Row, Slider } from './widgets';

const MODES: { value: DeviceMode; label: string; help: string }[] = [
  { value: 'poly', label: 'Poly', help: 'Up to Max voices notes at once; chords cost real voices.' },
  { value: 'mono', label: 'Mono', help: 'One voice; every note retriggers.' },
  { value: 'legato', label: 'Legato', help: 'One voice; overlapping notes glide without retriggering.' },
  { value: 'arp', label: 'Arp', help: 'Chords play as an arpeggio on one voice.' },
  { value: 'drum', label: 'Drum', help: 'Each key plays its zone at a fixed pitch; choke groups cut each other.' },
];

const DIRECTIONS: ArpDirection[] = ['up', 'down', 'upDown', 'asPlayed', 'random'];

/** Hardware ADSR times (approximate), for labels. */
const ATTACK_MS = [4100, 2600, 1500, 1000, 640, 380, 260, 160, 96, 64, 40, 24, 16, 10, 6, 0];
const DECAY_MS = [1200, 740, 440, 290, 180, 110, 74, 37];
const SR_MS = [
  Infinity, 38000, 28000, 24000, 19000, 14000, 12000, 9400, 7100, 5900, 4700, 3500, 2900, 2400, 1800, 1500, 1200, 880, 740, 590, 440, 370, 290, 220, 180, 150, 110, 92, 74, 55, 37, 18,
];

function ms(v: number): string {
  if (!Number.isFinite(v)) return '∞';
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`;
}

export function DevicePanel() {
  const devices = useStore((s) => s.project.devices);
  const selected = useStore((s) => s.ui.selectedDeviceId);
  const device = devices.find((d) => d.id === selected);
  const samples = useStore((s) => s.project.samples);

  const add = () => {
    const d = newDevice(`Device ${devices.length + 1}`, 'poly', samples[0] ? [newZone(samples[0].id)] : []);
    store.update((p) => ({ ...p, devices: [...p.devices, d] }));
    store.setUi({ selectedDeviceId: d.id });
  };
  const duplicate = () => {
    if (!device) return;
    const d = { ...structuredClone(device), id: newId('dev'), name: `${device.name} copy` };
    store.update((p) => ({ ...p, devices: [...p.devices, d] }));
    store.setUi({ selectedDeviceId: d.id });
  };
  const remove = () => {
    if (!device || !confirm(`Delete device "${device.name}"? Tracks using it fall silent.`)) return;
    store.update((p) => ({
      ...p,
      devices: p.devices.filter((d) => d.id !== device.id).map((d) => (d.pitchModSource === device.id ? { ...d, pitchModSource: null } : d)),
      patterns: p.patterns.map((pat) => ({ ...pat, tracks: pat.tracks.map((t) => (t.deviceId === device.id ? { ...t, deviceId: null } : t)) })),
    }));
  };

  return (
    <div className="side-panel">
      <div className="list">
        {devices.map((d) => (
          <div key={d.id} className={`list-item${d.id === selected ? ' active' : ''}`} onClick={() => store.setUi({ selectedDeviceId: d.id })}>
            {d.name} <span className="dim right">{d.mode}</span>
          </div>
        ))}
        {devices.length === 0 && <div className="dim pad">No devices yet.</div>}
      </div>
      <div className="button-row">
        <button onClick={add}>New device</button>
        <button onClick={duplicate} disabled={!device}>
          Duplicate
        </button>
        <button className="danger" onClick={remove} disabled={!device}>
          Delete
        </button>
      </div>
      {device && <DeviceEditor device={device} />}
    </div>
  );
}

function DeviceEditor({ device }: { device: Device }) {
  const samples = useStore((s) => s.project.samples);
  const set = (patch: Partial<Device>, key: string) =>
    store.update((p) => ({ ...p, devices: p.devices.map((d) => (d.id === device.id ? { ...d, ...patch } : d)) }), `${key}:${device.id}`);
  const setEnv = (patch: Partial<Envelope>) => set({ envelope: { ...device.envelope, ...patch } }, 'env');
  const setZone = (i: number, patch: Partial<Zone>) => set({ zones: device.zones.map((z, j) => (j === i ? { ...z, ...patch } : z)) }, `zone${i}`);
  const mode = MODES.find((m) => m.value === device.mode)!;
  const usesVoices = device.mode === 'poly' || device.mode === 'drum';

  return (
    <div className="editor">
      <Row label="Name">
        <input value={device.name} onChange={(e) => set({ name: e.target.value }, 'name')} />
      </Row>
      <Row label="Mode" title={mode.help}>
        <select value={device.mode} onChange={(e) => set({ mode: e.target.value as DeviceMode }, 'mode')}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Row>
      <div className="dim small">{mode.help}</div>
      {usesVoices && (
        <Row label="Max voices" title="Hardware voices this device may use at once. At the limit it steals its own oldest voice.">
          <Slider value={device.maxVoices} min={1} max={8} onChange={(v) => set({ maxVoices: v }, 'maxv')} />
        </Row>
      )}
      <Row label="Priority" title="Higher priority voices are stolen last, and never by lower priority devices.">
        <Slider value={device.priority} min={0} max={255} onChange={(v) => set({ priority: v }, 'prio')} />
      </Row>
      <Row label="Volume">
        <Slider value={device.volume} min={0} max={127} onChange={(v) => set({ volume: v }, 'vol')} />
      </Row>
      <Row label="Pan">
        <Slider value={device.pan} min={-64} max={63} onChange={(v) => set({ pan: v }, 'pan')} />
      </Row>
      <Row label="Fine tune" title="Detune in cents, added to every note of this device.">
        <Slider value={device.fineTune} min={-100} max={100} onChange={(v) => set({ fineTune: v }, 'fine')} format={(v) => `${v > 0 ? '+' : ''}${v} ct`} />
      </Row>
      <Row label="Echo" title="Route this device's voices to the global echo unit.">
        <input type="checkbox" checked={device.echo} onChange={(e) => set({ echo: e.target.checked }, 'echo')} />
      </Row>
      <ChipSettings device={device} set={set} />

      {device.mode === 'arp' && (
        <fieldset>
          <legend>Arpeggio</legend>
          <Row label="Rate" title="Ticks per step">
            <Slider value={device.arp.rate} min={1} max={24} onChange={(v) => set({ arp: { ...device.arp, rate: v } }, 'arprate')} format={(v) => `${v} ticks`} />
          </Row>
          <Row label="Direction">
            <select value={device.arp.direction} onChange={(e) => set({ arp: { ...device.arp, direction: e.target.value as ArpDirection } }, 'arpdir')}>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Octaves">
            <Slider value={device.arp.octaves} min={1} max={4} onChange={(v) => set({ arp: { ...device.arp, octaves: v } }, 'arpoct')} />
          </Row>
        </fieldset>
      )}
      {device.mode === 'legato' && (
        <Row label="Portamento" title="Glide time between legato notes in ticks (0 = jump).">
          <Slider value={device.legatoPortamento} min={0} max={48} onChange={(v) => set({ legatoPortamento: v }, 'porta')} format={(v) => `${v} ticks`} />
        </Row>
      )}

      <fieldset>
        <legend>Envelope (hardware ADSR)</legend>
        <Row label="Attack">
          <Slider value={device.envelope.attack} min={0} max={15} onChange={(v) => setEnv({ attack: v })} format={(v) => ms(ATTACK_MS[v])} />
        </Row>
        <Row label="Decay">
          <Slider value={device.envelope.decay} min={0} max={7} onChange={(v) => setEnv({ decay: v })} format={(v) => ms(DECAY_MS[v])} />
        </Row>
        <Row label="Sustain lvl">
          <Slider value={device.envelope.sustainLevel} min={0} max={7} onChange={(v) => setEnv({ sustainLevel: v })} format={(v) => `${v + 1}/8`} />
        </Row>
        <Row label="Sustain rate" title="How fast the note fades while held, after reaching the sustain level.">
          <Slider value={device.envelope.sustainRate} min={0} max={31} onChange={(v) => setEnv({ sustainRate: v })} format={(v) => ms(SR_MS[v])} />
        </Row>
      </fieldset>
      <GainSection device={device} set={set} />
      <ReleaseSection device={device} set={set} />

      <fieldset>
        <legend>
          <input
            type="checkbox"
            checked={!!device.vibrato}
            onChange={(e) => set({ vibrato: e.target.checked ? { depth: 0.2, rate: 24, delay: 12, fadeIn: 0 } : null }, 'vib')}
          />{' '}
          Vibrato
        </legend>
        {device.vibrato && (
          <>
            <Row label="Depth">
              <Slider value={device.vibrato.depth} min={0} max={2} step={0.01} onChange={(v) => set({ vibrato: { ...device.vibrato!, depth: v } }, 'vibd')} format={(v) => `${v.toFixed(2)} st`} />
            </Row>
            <Row label="Period">
              <Slider value={device.vibrato.rate} min={2} max={96} onChange={(v) => set({ vibrato: { ...device.vibrato!, rate: v } }, 'vibr')} format={(v) => `${v} ticks`} />
            </Row>
            <Row label="Delay">
              <Slider value={device.vibrato.delay} min={0} max={96} onChange={(v) => set({ vibrato: { ...device.vibrato!, delay: v } }, 'vibdl')} format={(v) => `${v} ticks`} />
            </Row>
            <Row label="Fade-in" title="Ticks over which the depth grows from 0 to full after the delay.">
              <Slider value={device.vibrato.fadeIn} min={0} max={96} onChange={(v) => set({ vibrato: { ...device.vibrato!, fadeIn: v } }, 'vibfi')} format={(v) => (v === 0 ? 'off' : `${v} ticks`)} />
            </Row>
          </>
        )}
      </fieldset>
      <TremoloSection device={device} set={set} />

      <fieldset>
        <legend>Zones (first match wins)</legend>
        {device.zones.map((z, i) => (
          <div key={i} className="zone">
            <div className="zone-head">
              <select value={z.sampleId} onChange={(e) => setZone(i, { sampleId: e.target.value })}>
                {samples.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                {!samples.some((s) => s.id === z.sampleId) && <option value={z.sampleId}>(missing)</option>}
              </select>
              <button title="Audition this zone" onMouseDown={() => auditionOn('zone', z.fixedPitch !== undefined ? z.keyRange[0] : Math.round((z.keyRange[0] + z.keyRange[1]) / 2), 127, device.id)} onMouseUp={() => auditionOff('zone')} onMouseLeave={() => auditionOff('zone')}>
                ▶
              </button>
              <button className="danger" title="Remove zone" onClick={() => set({ zones: device.zones.filter((_, j) => j !== i) }, 'zones')}>
                ×
              </button>
            </div>
            <Row label="Keys">
              <NoteInput value={z.keyRange[0]} onChange={(v) => setZone(i, { keyRange: [v, Math.max(v, z.keyRange[1])] })} />
              <span className="dim">to</span>
              <NoteInput value={z.keyRange[1]} onChange={(v) => setZone(i, { keyRange: [Math.min(v, z.keyRange[0]), v] })} />
            </Row>
            <Row label="Root" title="Overrides the sample's root note for this zone.">
              <input type="checkbox" checked={z.rootNoteOverride !== undefined} onChange={(e) => setZone(i, { rootNoteOverride: e.target.checked ? (samples.find((s) => s.id === z.sampleId)?.rootNote ?? 60) : undefined })} />
              {z.rootNoteOverride !== undefined && <NoteInput value={z.rootNoteOverride} onChange={(v) => setZone(i, { rootNoteOverride: v })} />}
            </Row>
            {device.mode === 'drum' && (
              <>
                <Row label="Fixed pitch" title="Always play at this note, whatever key triggers the zone.">
                  <input type="checkbox" checked={z.fixedPitch !== undefined} onChange={(e) => setZone(i, { fixedPitch: e.target.checked ? (samples.find((s) => s.id === z.sampleId)?.rootNote ?? 60) : undefined })} />
                  {z.fixedPitch !== undefined && <NoteInput value={z.fixedPitch} onChange={(v) => setZone(i, { fixedPitch: v })} />}
                </Row>
                <Row label="Choke group" title="A new note in the group cuts the running one (e.g. open and closed hi-hat).">
                  <input type="checkbox" checked={z.chokeGroup !== undefined} onChange={(e) => setZone(i, { chokeGroup: e.target.checked ? 1 : undefined })} />
                  {z.chokeGroup !== undefined && <NumberInput value={z.chokeGroup} min={1} max={16} onChange={(v) => setZone(i, { chokeGroup: v })} width={48} />}
                </Row>
              </>
            )}
            <Row label="Noise" title="Play the S-DSP noise generator instead of the sample, at this noise clock. The clock is global: overlapping noise notes share the last one set. The sample still runs underneath, so a one-shot sample ends the noise.">
              <input type="checkbox" checked={z.noise !== undefined} onChange={(e) => setZone(i, { noise: e.target.checked ? 24 : undefined })} />
              {z.noise !== undefined && (
                <>
                  <NumberInput value={z.noise} min={0} max={31} onChange={(v) => setZone(i, { noise: v })} width={48} />
                  <span className="dim">{formatNoiseRate(z.noise)}</span>
                </>
              )}
            </Row>
            <Row label="Vol / pan">
              <NumberInput value={z.volume} min={0} max={127} onChange={(v) => setZone(i, { volume: v })} width={52} />
              <NumberInput value={z.pan} min={-64} max={63} onChange={(v) => setZone(i, { pan: v })} width={52} />
            </Row>
          </div>
        ))}
        <button disabled={samples.length === 0} onClick={() => set({ zones: [...device.zones, newZone(samples[0].id)] }, 'zones')}>
          + Zone
        </button>
      </fieldset>
    </div>
  );
}

/** Surround and pitch modulation: S-DSP voice features of the whole device. */
function ChipSettings({ device, set }: { device: Device; set: (patch: Partial<Device>, key: string) => void }) {
  const devices = useStore((s) => s.project.devices);
  return (
    <>
      <Row label="Surround" title="Invert the right channel (negative right volume): wider on stereo speakers, behind the listener on Dolby Surround.">
        <input type="checkbox" checked={device.surround} onChange={(e) => set({ surround: e.target.checked }, 'surround')} />
      </Row>
      <Row label="Pitch mod" title="PMON: this device's notes are frequency-modulated by the output of the voice just below them, which must play a note of the source device. A silent (volume 0) source still modulates.">
        <select value={device.pitchModSource ?? ''} onChange={(e) => set({ pitchModSource: e.target.value || null }, 'pmod')}>
          <option value="">Off</option>
          {devices
            .filter((d) => d.id !== device.id)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          {device.pitchModSource && !devices.some((d) => d.id === device.pitchModSource) && <option value={device.pitchModSource}>(missing)</option>}
        </select>
      </Row>
    </>
  );
}
