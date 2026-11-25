import { buildSample, type BuiltSample } from '../brr/sampleBuild';
import { VoiceAllocator } from '../compiler/allocate';
import { TrackProcessor, type ExpandContext, type LogicalNote, type SongPattern } from '../compiler/expand';
import { selectZone } from '../compiler/instrument';
import { VOICE_COUNT } from '../compiler/ir';
import { TRACK_DEFAULTS } from '../model/defaults';
import { NOTE_OFF, type Cell, type Device, type DeviceMode, type EchoSettings, type Project, type Sample, type Timing, type Track } from '../model/types';
import type { SDsp } from './sdsp';
import { applyVoiceEvent } from './sequencer';
import { DSP_RATE } from './tables';

/**
 * Live play (MIDI, computer keyboard, zone audition) with the device's real rules.
 *
 * Each device being played gets a `TrackProcessor` (the compiler's stage 2) and all of them share
 * a `VoiceAllocator` (stage 3), so mono, legato, arpeggio, choke groups and voice limits behave
 * exactly as in compiled playback. The player runs in the AudioWorklet at the song's tick rate and
 * drives its own S-DSP, so live notes never disturb the song's voices.
 *
 * Keys become the same column entries a pattern would contain. Two keyboard conventions are added
 * on top, because a held key is not a tracker cell: in mono and legato mode, releasing the sounding
 * key falls back to the most recent key still held; and one-shot drum samples ignore key release.
 */

/** What live play needs from the project. Sent to the worklet whenever it changes. */
export interface LiveSetup {
  devices: Device[];
  /** Samples without PCM, with the build facts that pitch and note length depend on. */
  samples: { sample: Sample; effectiveRate: number; length: number; loopBlock: number }[];
  timing: Timing;
  seed: number;
  echo: EchoSettings;
  mainVolumeL: number;
  mainVolumeR: number;
}

export function liveSetupFor(project: Project): LiveSetup {
  return {
    devices: project.devices,
    samples: project.samples.map((s) => {
      const b = buildSample(s);
      return { sample: { ...s, pcm: '' }, effectiveRate: b.effectiveRate, length: b.length, loopBlock: b.loopBlock };
    }),
    timing: project.timing,
    seed: project.seed,
    echo: project.hardware.echo,
    mainVolumeL: project.hardware.mainVolumeL,
    mainVolumeR: project.hardware.mainVolumeR,
  };
}

/** Enough note columns for a ten-finger chord plus sustain overlap. */
const COLUMNS = 16;
const ALL_VOICES = Array.from({ length: VOICE_COUNT }, (_, i) => i);

interface LiveTrack {
  proc: TrackProcessor;
  track: number;
  deviceId: string;
  mode: DeviceMode;
  /** Mono/legato: keys held, in press order (last = sounding). */
  held: { note: number; velocity: number }[];
  /** Other modes: the key held in each note column. */
  columns: (number | null)[];
}

export class LivePlayer {
  private ctx: ExpandContext | null = null;
  private tracks = new Map<string, LiveTrack>();
  private nextTrack = 0;
  private alloc = new VoiceAllocator(ALL_VOICES, 1);
  private releaseTicks = 1;
  private sounding: { note: LogicalNote; cursor: number }[] = [];
  private pending: { lt: LiveTrack; column: number; cell: Cell }[] = [];
  private tick = 0;
  private samplesPerTick = 640;
  private frac = 0;
  private samplesLeft = 0;

  constructor(readonly dsp: SDsp) {}

  setup(s: LiveSetup): void {
    const tpl = Math.max(1, Math.round(s.timing.ticksPerLine));
    this.samplesPerTick = (DSP_RATE * 60) / (s.timing.bpm * s.timing.linesPerBeat * tpl);
    const built = new Map<string, BuiltSample>();
    for (const x of s.samples) {
      built.set(x.sample.id, { sampleId: x.sample.id, brr: new Uint8Array(0), loopBlock: x.loopBlock, length: x.length, effectiveRate: x.effectiveRate, notes: [] });
    }
    const fields = {
      project: { seed: s.seed },
      tpl,
      samplesPerTick: this.samplesPerTick,
      devices: new Map(s.devices.map((d) => [d.id, d])),
      samples: new Map(s.samples.map((x) => [x.sample.id, x.sample])),
      built,
      slots: new Map(s.samples.map((x, i) => [x.sample.id, i])),
    };
    // Track processors keep a reference to the context, so update it in place.
    if (this.ctx) Object.assign(this.ctx, fields);
    else this.ctx = { ...fields, notes: [], globalEvents: [], diagnostics: [], diagKeys: new Set(), nextId: 0 };

    const releaseTicks = Math.max(1, Math.ceil(256 / this.samplesPerTick));
    if (releaseTicks !== this.releaseTicks) {
      this.allNotesOff();
      this.releaseTicks = releaseTicks;
      this.alloc = new VoiceAllocator(ALL_VOICES, releaseTicks);
    }
    // Edited devices apply to held notes; a changed mode or deleted device ends them.
    for (const lt of [...this.tracks.values()]) {
      const d = this.ctx.devices.get(lt.deviceId);
      if (!d || d.mode !== lt.mode) this.release(lt);
      else lt.proc.refreshDevice();
    }
    this.dsp.setEcho({ ...s.echo, fir: s.echo.fir.slice(0, 8) });
    this.dsp.setEchoWrite(s.echo.writeEnabled !== false);
    this.dsp.setMainVolume(s.mainVolumeL, s.mainVolumeR);
  }

  noteOn(deviceId: string, note: number, velocity: number): void {
    const lt = this.trackFor(deviceId);
    if (!lt) return;
    const volume = Math.max(1, Math.min(127, Math.round(velocity)));
    if (lt.mode === 'mono' || lt.mode === 'legato') {
      lt.held = lt.held.filter((h) => h.note !== note);
      lt.held.push({ note, velocity: volume });
      this.pending.push({ lt, column: 0, cell: { note, volume } });
      return;
    }
    let c = lt.columns.indexOf(note);
    if (c < 0) c = lt.columns.indexOf(null);
    if (c < 0) c = 0;
    lt.columns[c] = note;
    this.pending.push({ lt, column: c, cell: { note, volume } });
  }

  noteOff(deviceId: string, note: number): void {
    const lt = this.tracks.get(deviceId);
    if (!lt) return;
    if (lt.mode === 'mono' || lt.mode === 'legato') {
      const i = lt.held.findIndex((h) => h.note === note);
      if (i < 0) return;
      const wasSounding = i === lt.held.length - 1;
      lt.held.splice(i, 1);
      if (!wasSounding) return;
      const back = lt.held[lt.held.length - 1];
      this.pending.push({ lt, column: 0, cell: back ? { note: back.note, volume: back.velocity } : { note: NOTE_OFF } });
      return;
    }
    const c = lt.columns.indexOf(note);
    if (c < 0) return;
    lt.columns[c] = null;
    if (lt.mode === 'drum' && !this.loops(deviceId, note)) return;
    this.pending.push({ lt, column: c, cell: { note: NOTE_OFF } });
  }

  /** Releases every live note (the key-offs go out on the next tick). */
  allNotesOff(): void {
    for (const lt of [...this.tracks.values()]) this.release(lt);
  }

  /** Renders `count` samples at 32 kHz, running live ticks at the song's tempo. */
  render(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    // Keys pressed since the last block play now, not at the next tick boundary.
    if (this.pending.length > 0) {
      this.fire();
      this.frac = 0;
      this.samplesLeft = Math.round(this.samplesPerTick);
    }
    let done = 0;
    while (done < count) {
      if (this.samplesLeft <= 0) {
        this.fire();
        this.frac += this.samplesPerTick;
        this.samplesLeft = Math.floor(this.frac);
        this.frac -= this.samplesLeft;
        continue;
      }
      const chunk = Math.min(count - done, this.samplesLeft);
      this.dsp.render(outL, outR, offset + done, chunk);
      done += chunk;
      this.samplesLeft -= chunk;
    }
  }

  private trackFor(deviceId: string): LiveTrack | null {
    const existing = this.tracks.get(deviceId);
    if (existing) return existing;
    const device = this.ctx?.devices.get(deviceId);
    if (!this.ctx || !device) return null;
    const track = this.nextTrack++;
    const proc = new TrackProcessor(this.ctx, track);
    proc.enterPattern(this.liveSong(track, deviceId));
    const lt: LiveTrack = { proc, track, deviceId, mode: device.mode, held: [], columns: Array.from({ length: COLUMNS }, () => null) };
    this.tracks.set(deviceId, lt);
    return lt;
  }

  /** A one-track pseudo pattern, so the processor's source references stay well-formed. */
  private liveSong(track: number, deviceId: string | null): SongPattern {
    const tracks: Track[] = [];
    tracks[track] = { deviceId, noteColumns: COLUMNS, ...TRACK_DEFAULTS, cells: [] };
    return { orderIndex: -1, pattern: { id: 'live', name: 'Live', lines: 1, tracks }, startTick: this.tick };
  }

  /** Ends a track's notes (key-off) and forgets the track. */
  private release(lt: LiveTrack): void {
    lt.proc.enterPattern(this.liveSong(lt.track, null));
    this.tracks.delete(lt.deviceId);
    this.pending = this.pending.filter((p) => p.lt !== lt);
  }

  private loops(deviceId: string, note: number): boolean {
    const ctx = this.ctx!;
    const device = ctx.devices.get(deviceId);
    const zone = device && selectZone(device, note, ctx.samples)?.zone;
    return !!zone && (ctx.built.get(zone.sampleId)?.loopBlock ?? -1) >= 0;
  }

  /** One live tick: apply pressed keys, run the device rules, allocate voices, write the DSP. */
  private fire(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ++this.tick;
    for (const p of this.pending) p.lt.proc.entry({ offset: 0, line: 0, column: p.column, kind: 'cell', cell: p.cell }, t);
    this.pending = [];
    for (const lt of this.tracks.values()) lt.proc.tick(t, 0);

    // Same order as the compiler: events of notes that own voices first, then new notes.
    for (const s of this.sounding) {
      while (s.cursor < s.note.events.length) {
        const ev = s.note.events[s.cursor++];
        const v = this.alloc.applyEvent(s.note, ev, t);
        if (v >= 0) applyVoiceEvent(this.dsp, v, ev);
      }
    }
    const fresh = ctx.notes.splice(0);
    fresh.sort((x, y) => y.priority - x.priority || x.track - y.track || x.column - y.column || x.id - y.id);
    for (const n of fresh) {
      const a = this.alloc.assign(n, t);
      if (a.voice >= 0) applyVoiceEvent(this.dsp, a.voice, n.keyOn);
      this.sounding.push({ note: n, cursor: n.events.length });
    }

    // Notes that ended (released, replaced or finished) send nothing more.
    this.sounding = this.sounding.filter((s) => s.note.heldEnd === Infinity || s.cursor < s.note.events.length);
    ctx.diagnostics.length = 0;
    ctx.globalEvents.length = 0;
    if (t % 64 === 0) this.alloc.prune();
  }
}
