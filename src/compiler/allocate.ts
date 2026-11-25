import { noteName } from '../model/notes';
import { ChipVoices, markPitchModPairs, pitchModRank, pitchModVoice } from './chip';
import type { LogicalNote } from './expand';
import type { Diagnostic, GlobalEvent, KeyOnEvent, VoiceEvent } from './ir';
import { VOICE_COUNT } from './ir';

/**
 * Stage 3: deterministic voice allocation.
 *
 * Ticks are processed in order. Within a tick, events of notes that already own a voice go
 * first, then new notes, sorted by (device priority desc, track asc, column asc). Each new note:
 *   1. follows device rules: it takes over its group's voice (mono, legato, arp, one poly
 *      column), cuts its choke group, or steals its own device's oldest voice at `maxVoices`;
 *   2. otherwise takes the lowest free voice;
 *   3. otherwise steals: lowest priority first, then voices in release, then the oldest note.
 *      It never steals from a higher-priority device. If nothing qualifies, the note is dropped.
 *
 * `VoiceAllocator` holds these rules and is used incrementally both by the compiler (whole song)
 * and by live play in the worklet, so a live note gets its voice exactly as in playback.
 */

interface VoiceState {
  note: LogicalNote | null;
  /** Assignment order; lower = older. Breaks ties between notes started on the same tick. */
  seq: number;
  /** Tick the note's release began: its key-off, or the GAIN switch of a long release. */
  keyOffTick: number;
  freeAt: number;
}

export interface Assignment {
  /** The voice the note got, or -1 if it was dropped. */
  voice: number;
  /** A note that was still held and lost its voice to this one (a real steal). */
  stolen: LogicalNote | null;
  /** True when the steal happened because of the device's own voice limit. */
  byLimit: boolean;
}

export class VoiceAllocator {
  private state: VoiceState[] = Array.from({ length: VOICE_COUNT }, () => ({ note: null, seq: -1, keyOffTick: Infinity, freeAt: 0 }));
  private voiceOf = new Map<number, number>();
  private groupLast = new Map<string, LogicalNote>();
  private seq = 0;

  constructor(
    private readonly usable: number[],
    private readonly releaseTicks: number,
  ) {}

  isFree(v: number, tick: number): boolean {
    return this.state[v].note === null || tick >= this.state[v].freeAt;
  }

  /** The voice a note currently owns, or -1. */
  owns(n: LogicalNote): number {
    const v = this.voiceOf.get(n.id);
    return v !== undefined && this.state[v].note === n ? v : -1;
  }

  /** The note sounding on a voice (held or releasing), or null when the voice is free. */
  noteAt(v: number, tick: number): LogicalNote | null {
    return this.isFree(v, tick) ? null : this.state[v].note;
  }

  /** The note still holding a voice (not released or replaced), or null. */
  heldNoteAt(v: number, tick: number): LogicalNote | null {
    const n = this.noteAt(v, tick);
    return n && !this.inRelease(v, tick) && n.heldEnd > tick ? n : null;
  }

  private inRelease(v: number, tick: number): boolean {
    return this.state[v].keyOffTick <= tick;
  }

  usedAt(tick: number): number {
    let used = 0;
    for (const v of this.usable) if (!this.isFree(v, tick)) used++;
    return used;
  }

  /** Routes one of a note's own events. Returns the voice it applies to, or -1 if the note lost its voice. */
  applyEvent(note: LogicalNote, event: VoiceEvent, tick: number): number {
    const v = this.owns(note);
    if (v < 0) return -1;
    const s = this.state[v];
    if (event.type === 'setEnvelope' && event.release) {
      // A GAIN release: the voice is releasing from now on; its key-off follows once it is silent.
      s.keyOffTick = Math.min(s.keyOffTick, tick);
    } else if (event.type === 'keyOff') {
      // After a GAIN release the envelope is already at zero, so the voice is free at once.
      const silent = s.keyOffTick < tick;
      s.keyOffTick = Math.min(s.keyOffTick, tick);
      s.freeAt = Math.min(s.freeAt, silent ? tick : tick + this.releaseTicks);
    }
    return v;
  }

  /** Finds a voice for a new note by the rules above and assigns it. */
  assign(note: LogicalNote, tick: number): Assignment {
    const { usable, state } = this;
    let v = -1;
    let reason: 'group' | 'choke' | 'limit' | 'free' | 'steal' = 'free';

    // 1. Device rules.
    const prev = this.groupLast.get(note.group);
    if (prev) {
      const pv = this.owns(prev);
      if (pv >= 0) {
        v = pv;
        reason = 'group';
      }
    }
    if (v < 0 && note.chokeKey) {
      for (const u of usable) {
        const owner = state[u].note;
        if (owner && owner.chokeKey === note.chokeKey && !this.isFree(u, tick)) {
          v = u;
          reason = 'choke';
          break;
        }
      }
    }
    if (v < 0 && note.limitKey && Number.isFinite(note.maxVoices)) {
      const own = usable.filter((u) => state[u].note?.limitKey === note.limitKey && !this.isFree(u, tick));
      if (own.length >= note.maxVoices) {
        own.sort((x, y) => Number(this.inRelease(y, tick)) - Number(this.inRelease(x, tick)) || state[x].seq - state[y].seq || x - y);
        v = own[0];
        reason = 'limit';
      }
    }
    // Pitch modulation: the voice just above a voice playing the source device (see chip.ts).
    if (v < 0 && note.pitchModSource) v = pitchModVoice(this, usable, note, tick);
    // 2. Lowest free voice; a modulator whose partner starts now wants a free voice above it too.
    if (v < 0 && note.pairAbove) {
      for (const u of usable) {
        if (this.isFree(u, tick) && usable.includes(u + 1) && this.isFree(u + 1, tick)) {
          v = u;
          reason = 'free';
          break;
        }
      }
    }
    if (v < 0) {
      for (const u of usable) {
        if (this.isFree(u, tick)) {
          v = u;
          reason = 'free';
          break;
        }
      }
    }
    // 3. Steal.
    if (v < 0) {
      const candidates = usable.filter((u) => state[u].note!.priority <= note.priority);
      candidates.sort(
        (x, y) =>
          state[x].note!.priority - state[y].note!.priority ||
          Number(this.inRelease(y, tick)) - Number(this.inRelease(x, tick)) ||
          state[x].seq - state[y].seq ||
          x - y,
      );
      if (candidates.length > 0) {
        v = candidates[0];
        reason = 'steal';
      }
    }
    if (v < 0) return { voice: -1, stolen: null, byLimit: false };

    const old = state[v].note;
    const stolen =
      old && (reason === 'steal' || reason === 'limit') && !this.isFree(v, tick) && !this.inRelease(v, tick) && old.heldEnd > tick ? old : null;
    state[v] = { note, seq: this.seq++, keyOffTick: Infinity, freeAt: note.naturalEnd };
    this.voiceOf.set(note.id, v);
    this.groupLast.set(note.group, note);
    return { voice: v, stolen, byLimit: reason === 'limit' };
  }

  /** Forgets notes that no longer own a voice. Live play calls this so memory stays bounded. */
  prune(): void {
    for (const [group, n] of this.groupLast) if (this.owns(n) < 0) this.groupLast.delete(group);
    for (const [id, v] of this.voiceOf) if (this.state[v].note?.id !== id) this.voiceOf.delete(id);
  }
}

export interface AllocationResult {
  lanes: VoiceEvent[][];
  /** Voices in use at each tick. */
  usedPerTick: Uint8Array;
  /** Global events from voice allocation (noise clock writes of the notes that got a voice). */
  global: GlobalEvent[];
}

/** Allocates voices for a whole song and writes the voice lanes of the IR. */
export function allocateVoices(
  notes: LogicalNote[],
  usable: number[],
  releaseTicks: number,
  totalTicks: number,
  diagnostics: Diagnostic[],
  describe: (n: LogicalNote) => string,
): AllocationResult {
  const lanes: VoiceEvent[][] = Array.from({ length: VOICE_COUNT }, () => []);
  const alloc = new VoiceAllocator(usable, releaseTicks);
  const keyOnOut = new Map<number, KeyOnEvent>();
  const usedPerTick = new Uint8Array(Math.max(0, totalTicks));
  const global: GlobalEvent[] = [];
  const chip = new ChipVoices({ voice: (v, ev) => lanes[v].push(ev), global: (ev) => global.push(ev), diagnostic: (d) => diagnostics.push(d) }, describe);

  // Bucket work by tick.
  type Item = { note: LogicalNote; event: VoiceEvent };
  const buckets = new Map<number, { events: Item[]; requests: LogicalNote[] }>();
  const bucket = (t: number) => {
    let b = buckets.get(t);
    if (!b) buckets.set(t, (b = { events: [], requests: [] }));
    return b;
  };
  for (const n of notes) {
    bucket(n.startTick).requests.push(n);
    for (const e of n.events) bucket(e.tick).events.push({ note: n, event: e });
  }
  const ticks = [...buckets.keys()].sort((a, b) => a - b);

  let usageTick = 0;
  const recordUsageUntil = (tick: number) => {
    for (; usageTick < Math.min(tick, totalTicks); usageTick++) usedPerTick[usageTick] = alloc.usedAt(usageTick);
  };

  for (const tick of ticks) {
    recordUsageUntil(tick);
    const b = buckets.get(tick)!;
    b.events.sort((x, y) => x.note.id - y.note.id);
    for (const { note, event } of b.events) {
      const v = alloc.applyEvent(note, event, tick);
      if (v >= 0) {
        lanes[v].push(event);
        chip.routed(alloc, note, v, event, tick);
      }
    }

    markPitchModPairs(b.requests);
    b.requests.sort((x, y) => pitchModRank(x) - pitchModRank(y) || y.priority - x.priority || x.track - y.track || x.column - y.column || x.id - y.id);
    for (const note of b.requests) {
      const a = alloc.assign(note, tick);
      if (a.voice < 0) {
        diagnostics.push({
          kind: 'noteDropped',
          severity: 'error',
          message: `${describe(note)} was dropped: all voices are busy with higher-priority notes.`,
          source: note.keyOn.source,
          tick,
        });
        continue;
      }
      if (a.stolen) {
        diagnostics.push({
          kind: 'voiceStolen',
          severity: 'warning',
          message: `Voice ${a.voice} taken from ${describe(a.stolen)} by ${describe(note)}${a.byLimit ? ' (device voice limit)' : ''}.`,
          source: a.stolen.keyOn.source,
          tick,
          voice: a.voice,
        });
        const k = keyOnOut.get(a.stolen.id);
        if (k) k.stolen = true;
      }
      const keyOn: KeyOnEvent = { ...note.keyOn };
      keyOnOut.set(note.id, keyOn);
      lanes[a.voice].push(keyOn);
      chip.assigned(alloc, note, a.voice, tick);
    }
  }
  recordUsageUntil(totalTicks);
  return { lanes, usedPerTick, global };
}

export function describeNote(n: LogicalNote, deviceName: string): string {
  return `${noteName(n.keyOn.note)} (${deviceName}, track ${n.track + 1})`;
}
