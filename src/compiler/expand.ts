import type { BuiltSample } from '../brr/sampleBuild';
import type { Cell, Device, Effect, Pattern, Project, Sample, Zone } from '../model/types';
import { NOTE_CUT, NOTE_OFF } from '../model/types';
import { noteName } from '../model/notes';
import { hashString, mulberry32 } from '../util/prng';
import { pitchFor, playLengthSamples, selectZone, stereoVolume, toDspEnvelope, zoneRoot } from './instrument';
import type { Diagnostic, KeyOnEvent, SourceRef, VoiceEvent } from './ir';

/**
 * Stages 1 and 2 of the compiler.
 *
 * Stage 1 parses a pattern into time-ordered column entries. It depends only on the pattern and
 * ticks-per-line, so it is cached per pattern object: editing one pattern re-parses only that one.
 *
 * Stage 2 runs each track through its device's rules (mono, legato, poly, arp, drum) and the
 * per-line effects, tick by tick, and produces "logical notes": everything that wants a hardware
 * voice, with the events it will send to that voice. Which voice it gets is stage 3's job.
 */

// ---------------------------------------------------------------- stage 1

export interface Entry {
  /** Tick offset within the pattern. */
  offset: number;
  line: number;
  column: number;
  /** 'fx' entries fire at line start; 'cell' entries at line start + note delay. */
  kind: 'fx' | 'cell';
  cell: Cell;
}

const parseCache = new WeakMap<Pattern, { tpl: number; tracks: Entry[][] }>();

export function parsePattern(pattern: Pattern, tpl: number): Entry[][] {
  const cached = parseCache.get(pattern);
  if (cached && cached.tpl === tpl) return cached.tracks;
  const tracks = pattern.tracks.map((track) => {
    const entries: Entry[] = [];
    for (let line = 0; line < pattern.lines; line++) {
      const row = track.cells[line];
      if (!row) continue;
      for (let column = 0; column < track.noteColumns; column++) {
        const cell = row[column];
        if (!cell) continue;
        if (cell.fx) entries.push({ offset: line * tpl, line, column, kind: 'fx', cell });
        if (cell.note !== undefined || cell.volume !== undefined || cell.pan !== undefined) {
          const delay = Math.max(0, Math.min(tpl - 1, cell.delay ?? 0));
          entries.push({ offset: line * tpl + delay, line, column, kind: 'cell', cell });
        }
      }
    }
    // Stable order: by tick, fx before cells, then column.
    entries.sort((a, b) => a.offset - b.offset || (a.kind === b.kind ? 0 : a.kind === 'fx' ? -1 : 1) || a.column - b.column);
    return entries;
  });
  parseCache.set(pattern, { tpl, tracks });
  return tracks;
}

// ---------------------------------------------------------------- stage 2

/** Everything that wants one hardware voice, from key-on until it ends or is replaced. */
export interface LogicalNote {
  id: number;
  track: number;
  column: number;
  /** Notes of the same group take over each other's voice (mono, arp, one poly column). */
  group: string;
  deviceId: string;
  priority: number;
  /** Device-wide voice limit (poly/drum), keyed by device. */
  limitKey: string | null;
  maxVoices: number;
  /** Drum choke group key: a new note cuts the running note with the same key. */
  chokeKey: string | null;
  startTick: number;
  keyOn: KeyOnEvent;
  events: VoiceEvent[];
  /** Tick at which the note stops wanting its voice (key-off or successor). */
  heldEnd: number;
  /** Tick at which a one-shot sample has finished playing. */
  naturalEnd: number;
}

export interface ExpandContext {
  /** Only the seed is needed here; live play passes just that. */
  project: Pick<Project, 'seed'>;
  tpl: number;
  samplesPerTick: number;
  devices: Map<string, Device>;
  samples: Map<string, Sample>;
  built: Map<string, BuiltSample>;
  slots: Map<string, number>;
  notes: LogicalNote[];
  diagnostics: Diagnostic[];
  diagKeys: Set<string>;
  nextId: number;
}

export function diagnoseOnce(ctx: ExpandContext, key: string, d: Diagnostic): void {
  if (ctx.diagKeys.has(key)) return;
  ctx.diagKeys.add(key);
  ctx.diagnostics.push(d);
}

/** A note being played by a track: the state that stage 2 evolves tick by tick. */
interface Active {
  ln: LogicalNote | null;
  device: Device;
  zone: Zone;
  sample: Sample;
  built: BuiltSample;
  root: number;
  /** The key that was pressed (display and zone choice). */
  note: number;
  /** Current pitch in fractional MIDI notes, before vibrato. */
  pitch: number;
  vibFx: number;
  vibPhase: number;
  age: number;
  vol: number;
  pan: number;
  column: number;
  group: string;
  source: SourceRef;
  portaTarget: number | null;
  glide: { from: number; to: number; start: number; len: number } | null;
  lastPitch: number;
  lastVolL: number;
  lastVolR: number;
  /** Set when a cell (not modulation) changed this note during the current tick. */
  cellTouched: boolean;
}

interface HeldKey {
  note: number;
  vol: number;
  pan: number;
  source: SourceRef;
  order: number;
}

export interface SongPattern {
  orderIndex: number;
  pattern: Pattern;
  startTick: number;
}

/** Runs stage 2 for one track index over the whole song. */
export function expandTrack(ctx: ExpandContext, trackIndex: number, song: SongPattern[]): void {
  const proc = new TrackProcessor(ctx, trackIndex);
  for (const sp of song) {
    const entries = parsePattern(sp.pattern, ctx.tpl)[trackIndex] ?? [];
    proc.enterPattern(sp);
    const ticks = sp.pattern.lines * ctx.tpl;
    let e = 0;
    for (let off = 0; off < ticks; off++) {
      const tick = sp.startTick + off;
      if (off % ctx.tpl === 0) proc.lineStart();
      while (e < entries.length && entries[e].offset === off) {
        proc.entry(entries[e], tick);
        e++;
      }
      proc.tick(tick, off % ctx.tpl);
    }
  }
  proc.finish(song.length ? song[song.length - 1].startTick + song[song.length - 1].pattern.lines * ctx.tpl : 0);
}

export class TrackProcessor {
  private device: Device | null = null;
  private deviceId: string | null | undefined = undefined;
  private sp: SongPattern | null = null;
  /** All notes this track is currently sounding (not yet released or replaced). */
  private actives: Active[] = [];
  /** Per column: the note it last started (poly/drum). */
  private colActive: (Active | null)[] = [];
  /** The single note of mono/legato/arp devices. */
  private solo: Active | null = null;
  /** Per column: the effect for the current line. */
  private colFx: (Effect | null)[] = [];
  private fxTargets: Map<Active, Effect> = new Map();
  // Arp state.
  private held: (HeldKey | null)[] = [];
  private heldOrder = 0;
  private arpResync = false;
  private arpRunning = false;
  private arpStart = 0;
  private arpStep = 0;
  private uniq = 0;
  private readonly rng: () => number;

  constructor(
    private ctx: ExpandContext,
    private track: number,
  ) {
    this.rng = mulberry32((ctx.project.seed ^ hashString(`track:${track}`)) >>> 0);
  }

  enterPattern(sp: SongPattern): void {
    this.sp = sp;
    const t = sp.pattern.tracks[this.track];
    const id = t ? t.deviceId : undefined;
    if (id !== this.deviceId) {
      // A different device (or no track) takes over this channel: end what was playing.
      this.releaseAll(sp.startTick, null);
      this.deviceId = id;
      this.device = id ? (this.ctx.devices.get(id) ?? null) : null;
      this.held = [];
      this.colActive = [];
      this.arpRunning = false;
      if (t && t.deviceId && !this.device) {
        diagnoseOnce(this.ctx, `nodev:${sp.pattern.id}:${this.track}`, {
          kind: 'noDevice',
          severity: 'warning',
          message: `Track ${this.track + 1} in pattern "${sp.pattern.name}" uses a device that no longer exists.`,
          source: this.src(0, 0),
          tick: sp.startTick,
        });
      }
    }
  }

  /** Live play: picks up edited settings of the same device without cutting held notes. */
  refreshDevice(): void {
    if (this.deviceId) this.device = this.ctx.devices.get(this.deviceId) ?? null;
  }

  lineStart(): void {
    this.colFx = [];
  }

  private src(line: number, column: number): SourceRef {
    const sp = this.sp!;
    return { orderIndex: sp.orderIndex, patternId: sp.pattern.id, track: this.track, line, column };
  }

  entry(en: Entry, tick: number): void {
    const source = this.src(en.line, en.column);
    if (en.kind === 'fx') {
      this.colFx[en.column] = en.cell.fx ?? null;
      return;
    }
    const cell = en.cell;
    const device = this.device;
    if (!device) {
      if (typeof cell.note === 'number' && this.sp!.pattern.tracks[this.track]?.deviceId == null) {
        diagnoseOnce(this.ctx, `nodevnote:${this.sp!.pattern.id}:${this.track}`, {
          kind: 'noDevice',
          severity: 'warning',
          message: `Track ${this.track + 1} in pattern "${this.sp!.pattern.name}" has notes but no device.`,
          source,
          tick,
        });
      }
      return;
    }
    const fx = this.colFx[en.column] ?? null;
    switch (device.mode) {
      case 'poly':
      case 'drum':
        this.polyEntry(device, en, cell, tick, source, fx);
        break;
      case 'mono':
      case 'legato':
        this.soloEntry(device, en, cell, tick, source, fx);
        break;
      case 'arp':
        this.arpEntry(cell, en.column, source);
        break;
    }
  }

  private polyEntry(device: Device, en: Entry, cell: Cell, tick: number, source: SourceRef, fx: Effect | null): void {
    const c = en.column;
    const cur = this.colActive[c] ?? null;
    if (cell.note === NOTE_OFF || cell.note === NOTE_CUT) {
      if (cur) this.release(cur, tick, source, cell.note === NOTE_CUT);
      this.colActive[c] = null;
      return;
    }
    if (typeof cell.note === 'number') {
      if (fx?.type === 'porta' && cur && device.mode === 'poly') {
        cur.portaTarget = cell.note;
        this.applyVolPan(cur, cell);
        return;
      }
      const vol = cell.volume ?? 127;
      const pan = cell.pan ?? 0;
      let group: string;
      if (device.mode === 'poly') {
        group = `t${this.track}c${c}`;
        if (cur) this.replace(cur, tick);
      } else {
        group = `d${this.track}_${this.uniq++}`;
      }
      const a = this.makeActive(device, cell.note, vol, pan, c, group, source, tick);
      if (a) {
        if (device.mode === 'drum' && a.zone.chokeGroup !== undefined) {
          // Same-track choke: the old note stops wanting a voice (the allocator also reuses it).
          for (const other of [...this.actives]) {
            if (other !== a && other.zone.chokeGroup === a.zone.chokeGroup) this.replace(other, tick);
          }
        }
        this.colActive[c] = a;
      }
      return;
    }
    if (cur) this.applyVolPan(cur, cell);
  }

  private soloEntry(device: Device, en: Entry, cell: Cell, tick: number, source: SourceRef, fx: Effect | null): void {
    const cur = this.solo;
    if (cell.note === NOTE_OFF || cell.note === NOTE_CUT) {
      if (cur) this.release(cur, tick, source, cell.note === NOTE_CUT);
      this.solo = null;
      return;
    }
    if (typeof cell.note === 'number') {
      if (cur && fx?.type === 'porta') {
        cur.portaTarget = cell.note;
        this.applyVolPan(cur, cell);
        return;
      }
      if (cur && device.mode === 'legato') {
        // Legato: change pitch without a new key-on.
        if (device.legatoPortamento > 0) {
          cur.glide = { from: cur.pitch, to: cell.note, start: tick, len: device.legatoPortamento };
        } else {
          cur.pitch = cell.note;
          cur.glide = null;
        }
        cur.note = cell.note;
        cur.source = source;
        cur.cellTouched = true;
        this.applyVolPan(cur, cell);
        return;
      }
      if (cur) this.replace(cur, tick);
      this.solo = this.makeActive(device, cell.note, cell.volume ?? 127, cell.pan ?? 0, en.column, `t${this.track}`, source, tick);
      return;
    }
    if (cur) this.applyVolPan(cur, cell);
  }

  private arpEntry(cell: Cell, column: number, source: SourceRef): void {
    if (cell.note === NOTE_OFF || cell.note === NOTE_CUT) {
      this.held[column] = null;
      return;
    }
    if (typeof cell.note === 'number') {
      this.held[column] = { note: cell.note, vol: cell.volume ?? 127, pan: cell.pan ?? 0, source, order: this.heldOrder++ };
      this.arpResync = true;
      return;
    }
    const h = this.held[column];
    if (h) {
      if (cell.volume !== undefined) h.vol = cell.volume;
      if (cell.pan !== undefined) h.pan = cell.pan;
    }
    if (this.solo) this.applyVolPan(this.solo, cell);
  }

  private applyVolPan(a: Active, cell: Cell): void {
    if (cell.volume !== undefined) a.vol = cell.volume;
    if (cell.pan !== undefined) a.pan = cell.pan;
    a.cellTouched = true;
  }

  /** Per-tick work after this tick's cells: arpeggiator, effects, then emit events. */
  tick(tick: number, lineTick: number): void {
    // A one-shot sample that has finished needs no further updates: stop tracking it, so drum
    // hits do not pile up for the rest of the song.
    for (const a of [...this.actives]) {
      if (a.ln && tick >= a.ln.naturalEnd) {
        a.ln.heldEnd = Math.min(a.ln.heldEnd, a.ln.naturalEnd);
        this.drop(a);
      }
    }
    const device = this.device;
    if (device?.mode === 'arp') this.arpTick(device, tick);

    // Effects of the current line, applied to the note each column controls.
    this.fxTargets.clear();
    for (let c = 0; c < this.colFx.length; c++) {
      const fx = this.colFx[c];
      if (!fx) continue;
      const target = device && (device.mode === 'poly' || device.mode === 'drum') ? this.colActive[c] : this.solo;
      if (target && !this.fxTargets.has(target)) this.fxTargets.set(target, fx);
    }
    for (const a of [...this.actives]) {
      const fx = this.fxTargets.get(a) ?? null;
      this.applyFx(a, fx, tick, lineTick);
    }
    for (const a of this.actives) this.emit(a, tick);
  }

  private applyFx(a: Active, fx: Effect | null, tick: number, lineTick: number): void {
    const tpl = this.ctx.tpl;
    if (a.glide) {
      const p = Math.min(1, (tick - a.glide.start) / a.glide.len);
      a.pitch = a.glide.from + (a.glide.to - a.glide.from) * p;
      if (p >= 1) a.glide = null;
    }
    if (!fx || fx.type !== 'vibrato') {
      a.vibFx = 0;
      a.vibPhase = 0;
    }
    if (!fx) return;
    const v = fx.value;
    switch (fx.type) {
      case 'slideUp':
        a.pitch += v / 16 / tpl;
        break;
      case 'slideDown':
        a.pitch -= v / 16 / tpl;
        break;
      case 'porta':
        if (a.portaTarget !== null) {
          const step = v / 16 / tpl;
          const d = a.portaTarget - a.pitch;
          if (Math.abs(d) <= step) {
            a.pitch = a.portaTarget;
            a.portaTarget = null;
          } else a.pitch += Math.sign(d) * step;
        }
        break;
      case 'vibrato': {
        const depth = (v >> 4) / 4;
        const period = Math.max(1, v & 15) * 2;
        a.vibFx = depth * Math.sin((2 * Math.PI * a.vibPhase) / period);
        a.vibPhase++;
        break;
      }
      case 'volSlide':
        a.vol = Math.max(0, Math.min(127, a.vol + (v >> 4) - (v & 15)));
        break;
      case 'cut':
        if (lineTick === v) this.release(a, tick, a.source, true);
        break;
      case 'retrig':
        if (v > 0 && lineTick > 0 && lineTick % v === 0) {
          const b = this.makeActive(a.device, a.note, a.vol, a.pan, a.column, a.group, a.source, tick);
          if (b) {
            b.pitch = a.pitch;
            const wasSolo = this.solo === a;
            const wasCol = this.colActive[a.column] === a;
            this.replace(a, tick);
            if (wasSolo) this.solo = b;
            if (wasCol) this.colActive[a.column] = b;
          }
        }
        break;
    }
  }

  private arpTick(device: Device, tick: number): void {
    const keys = this.held.filter((h): h is HeldKey => !!h);
    if (keys.length === 0) {
      if (this.solo) this.release(this.solo, tick, this.solo.source, false);
      this.solo = null;
      this.arpRunning = false;
      return;
    }
    if (this.arpResync || !this.arpRunning) {
      this.arpStart = tick;
      this.arpStep = 0;
      this.arpRunning = true;
      this.arpResync = false;
    }
    const rate = Math.max(1, device.arp.rate);
    if ((tick - this.arpStart) % rate !== 0) return;
    const seq = arpSequence(keys, device.arp.direction, device.arp.octaves);
    const pick = device.arp.direction === 'random' ? seq[Math.floor(this.rng() * seq.length)] : seq[this.arpStep % seq.length];
    this.arpStep++;
    if (this.solo) this.replace(this.solo, tick);
    this.solo = this.makeActive(device, pick.note, pick.vol, pick.pan, pick.column, `t${this.track}`, pick.source, tick);
  }

  private makeActive(device: Device, note: number, vol: number, pan: number, column: number, group: string, source: SourceRef, tick: number): Active | null {
    const ctx = this.ctx;
    const match = selectZone(device, note, ctx.samples);
    if (!match) {
      diagnoseOnce(ctx, `nozones:${device.id}`, {
        kind: 'noZone',
        severity: 'warning',
        message: `Device "${device.name}" has no zones, so its notes are silent.`,
        source,
        tick,
      });
      return null;
    }
    if (!match.exact) {
      diagnoseOnce(ctx, `nozone:${device.id}:${note}`, {
        kind: 'noZone',
        severity: 'warning',
        message: `No zone of "${device.name}" covers ${noteName(note)}; using the zone with the nearest root note.`,
        source,
        tick,
      });
    }
    const zone = match.zone;
    const sample = ctx.samples.get(zone.sampleId);
    const built = ctx.built.get(zone.sampleId);
    if (!sample || !built) {
      diagnoseOnce(ctx, `nosample:${device.id}:${zone.sampleId}`, {
        kind: 'noSample',
        severity: 'warning',
        message: `A zone of "${device.name}" points to a missing sample.`,
        source,
        tick,
      });
      return null;
    }
    const playNote = device.mode === 'drum' && zone.fixedPitch !== undefined ? zone.fixedPitch : note;
    const a: Active = {
      ln: null,
      device,
      zone,
      sample,
      built,
      root: zoneRoot(zone, ctx.samples),
      note,
      pitch: playNote,
      vibFx: 0,
      vibPhase: 0,
      age: 0,
      vol,
      pan,
      column,
      group,
      source,
      portaTarget: null,
      glide: null,
      lastPitch: -1,
      lastVolL: -1,
      lastVolR: -1,
      cellTouched: true,
    };
    this.actives.push(a);
    return a;
  }

  private emit(a: Active, tick: number): void {
    const ctx = this.ctx;
    const dev = a.device;
    let vib = 0;
    if (dev.vibrato && dev.vibrato.depth > 0 && a.age >= dev.vibrato.delay) {
      vib = dev.vibrato.depth * Math.sin((2 * Math.PI * (a.age - dev.vibrato.delay)) / Math.max(1, dev.vibrato.rate));
    }
    a.age++;
    const { pitch, clamped } = pitchFor(a.pitch + a.vibFx + vib, a.root, a.sample.fineTune, a.built);
    const volume = Math.round((dev.volume * a.zone.volume * a.vol) / (127 * 127));
    const { volL, volR } = stereoVolume(volume, dev.pan + a.zone.pan + a.pan);
    if (clamped) {
      diagnoseOnce(ctx, `clamp:${dev.id}:${Math.round(a.pitch)}`, {
        kind: 'pitchClamped',
        severity: 'warning',
        message: `${noteName(Math.round(a.pitch))} on "${dev.name}" is out of the pitch register's range (max about 2 octaves above the sample's root); clamped. Add a higher zone.`,
        source: a.source,
        tick,
      });
    }
    if (!a.ln) {
      const keyOn: KeyOnEvent = {
        tick,
        type: 'keyOn',
        source: a.source,
        sampleSlot: ctx.slots.get(a.sample.id)!,
        pitch,
        volL,
        volR,
        envelope: toDspEnvelope(a.zone.envelope ?? dev.envelope),
        echo: dev.echo,
        note: dev.mode === 'drum' ? a.note : Math.round(a.pitch),
        deviceId: dev.id,
      };
      if (clamped) keyOn.clamped = true;
      const playTicks = Math.ceil(playLengthSamples(a.built, pitch) / ctx.samplesPerTick);
      const poly = dev.mode === 'poly' || dev.mode === 'drum';
      a.ln = {
        id: ctx.nextId++,
        track: this.track,
        column: a.column,
        group: a.group,
        deviceId: dev.id,
        priority: dev.priority,
        limitKey: poly ? dev.id : null,
        maxVoices: poly ? Math.max(1, dev.maxVoices) : Infinity,
        chokeKey: dev.mode === 'drum' && a.zone.chokeGroup !== undefined ? `${dev.id}:${a.zone.chokeGroup}` : null,
        startTick: tick,
        keyOn,
        events: [],
        heldEnd: Infinity,
        naturalEnd: tick + playTicks,
      };
      ctx.notes.push(a.ln);
    } else {
      if (pitch !== a.lastPitch) {
        const ev: VoiceEvent = { tick, type: 'setPitch', pitch, source: a.source };
        if (!a.cellTouched) ev.auto = true;
        if (clamped) ev.clamped = true;
        a.ln.events.push(ev);
      }
      if (volL !== a.lastVolL || volR !== a.lastVolR) {
        const ev: VoiceEvent = { tick, type: 'setVolume', volL, volR, source: a.source };
        if (!a.cellTouched) ev.auto = true;
        a.ln.events.push(ev);
      }
    }
    a.lastPitch = pitch;
    a.lastVolL = volL;
    a.lastVolR = volR;
    a.cellTouched = false;
  }

  /** Key-off: the note releases (on hardware the release takes about 8 ms). */
  private release(a: Active, tick: number, source: SourceRef, cut: boolean): void {
    this.drop(a);
    if (!a.ln) return;
    if (cut) a.ln.events.push({ tick, type: 'setVolume', volL: 0, volR: 0, source });
    a.ln.events.push({ tick, type: 'keyOff', source });
    a.ln.heldEnd = Math.min(a.ln.heldEnd, tick);
  }

  /** A successor in the same group takes over the voice; no key-off needed. */
  private replace(a: Active, tick: number): void {
    this.drop(a);
    if (a.ln) a.ln.heldEnd = Math.min(a.ln.heldEnd, tick);
  }

  private drop(a: Active): void {
    const i = this.actives.indexOf(a);
    if (i >= 0) this.actives.splice(i, 1);
    if (this.solo === a) this.solo = null;
    for (let c = 0; c < this.colActive.length; c++) if (this.colActive[c] === a) this.colActive[c] = null;
  }

  private releaseAll(tick: number, source: SourceRef | null): void {
    for (const a of [...this.actives]) {
      if (source) this.release(a, tick, source, false);
      else if (a.ln) {
        a.ln.events.push({ tick, type: 'keyOff', source: a.source });
        a.ln.heldEnd = Math.min(a.ln.heldEnd, tick);
        this.drop(a);
      } else this.drop(a);
    }
  }

  finish(endTick: number): void {
    for (const a of [...this.actives]) {
      if (a.ln) a.ln.heldEnd = Math.min(a.ln.heldEnd, endTick);
      this.drop(a);
    }
  }
}

interface ArpStep {
  note: number;
  vol: number;
  pan: number;
  column: number;
  source: SourceRef;
}

/** The note sequence an arpeggiator cycles through for the held keys. */
export function arpSequence(keys: HeldKey[], direction: string, octaves: number): ArpStep[] {
  const base = direction === 'asPlayed' ? [...keys].sort((a, b) => a.order - b.order) : [...keys].sort((a, b) => a.note - b.note || a.order - b.order);
  const oct = Math.max(1, Math.min(4, Math.round(octaves)));
  const up: ArpStep[] = [];
  for (let o = 0; o < oct; o++) {
    for (const k of base) up.push({ note: k.note + 12 * o, vol: k.vol, pan: k.pan, column: k.source.column, source: k.source });
  }
  switch (direction) {
    case 'down':
      return up.reverse();
    case 'upDown':
      return up.length > 2 ? [...up, ...up.slice(1, -1).reverse()] : up;
    default:
      return up;
  }
}
