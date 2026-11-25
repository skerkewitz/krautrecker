import { noteName } from '../model/notes';
import type { LogicalNote } from './expand';
import type { Diagnostic, KeyOnEvent, VoiceEvent } from './ir';
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
 */

interface VoiceState {
  note: LogicalNote | null;
  /** Assignment order; lower = older. Breaks ties between notes started on the same tick. */
  seq: number;
  keyOffTick: number;
  freeAt: number;
}

export interface AllocationResult {
  lanes: VoiceEvent[][];
  /** Voices in use at each tick. */
  usedPerTick: Uint8Array;
}

export function allocateVoices(
  notes: LogicalNote[],
  usable: number[],
  releaseTicks: number,
  totalTicks: number,
  diagnostics: Diagnostic[],
  describe: (n: LogicalNote) => string,
): AllocationResult {
  const lanes: VoiceEvent[][] = Array.from({ length: VOICE_COUNT }, () => []);
  const state: VoiceState[] = Array.from({ length: VOICE_COUNT }, () => ({ note: null, seq: -1, keyOffTick: Infinity, freeAt: 0 }));
  const voiceOf = new Map<number, number>();
  const groupLast = new Map<string, LogicalNote>();
  const keyOnOut = new Map<number, KeyOnEvent>();
  const usedPerTick = new Uint8Array(Math.max(0, totalTicks));

  // Bucket work by tick.
  type Item = { note: LogicalNote; event: VoiceEvent | null };
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

  const isFree = (v: number, tick: number) => state[v].note === null || tick >= state[v].freeAt;
  const owns = (n: LogicalNote) => {
    const v = voiceOf.get(n.id);
    return v !== undefined && state[v].note === n ? v : -1;
  };
  const inRelease = (v: number, tick: number) => state[v].keyOffTick <= tick;

  let seq = 0;
  let usageTick = 0;
  const recordUsageUntil = (tick: number) => {
    for (; usageTick < Math.min(tick, totalTicks); usageTick++) {
      let used = 0;
      for (const v of usable) if (!isFree(v, usageTick)) used++;
      usedPerTick[usageTick] = used;
    }
  };

  for (const tick of ticks) {
    recordUsageUntil(tick);
    const b = buckets.get(tick)!;
    b.events.sort((x, y) => x.note.id - y.note.id);
    for (const { note, event } of b.events) {
      const v = owns(note);
      if (v < 0 || !event) continue;
      lanes[v].push(event);
      if (event.type === 'keyOff') {
        state[v].keyOffTick = Math.min(state[v].keyOffTick, tick);
        state[v].freeAt = Math.min(state[v].freeAt, tick + releaseTicks);
      }
    }

    b.requests.sort((x, y) => y.priority - x.priority || x.track - y.track || x.column - y.column || x.id - y.id);
    for (const note of b.requests) {
      let v = -1;
      let reason: 'group' | 'choke' | 'limit' | 'free' | 'steal' = 'free';

      // 1. Device rules.
      const prev = groupLast.get(note.group);
      if (prev) {
        const pv = owns(prev);
        if (pv >= 0) {
          v = pv;
          reason = 'group';
        }
      }
      if (v < 0 && note.chokeKey) {
        for (const u of usable) {
          const owner = state[u].note;
          if (owner && owner.chokeKey === note.chokeKey && !isFree(u, tick)) {
            v = u;
            reason = 'choke';
            break;
          }
        }
      }
      if (v < 0 && note.limitKey && Number.isFinite(note.maxVoices)) {
        const own = usable.filter((u) => state[u].note?.limitKey === note.limitKey && !isFree(u, tick));
        if (own.length >= note.maxVoices) {
          own.sort((x, y) => Number(inRelease(y, tick)) - Number(inRelease(x, tick)) || state[x].seq - state[y].seq || x - y);
          v = own[0];
          reason = 'limit';
        }
      }
      // 2. Lowest free voice.
      if (v < 0) {
        for (const u of usable) {
          if (isFree(u, tick)) {
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
            Number(inRelease(y, tick)) - Number(inRelease(x, tick)) ||
            state[x].seq - state[y].seq ||
            x - y,
        );
        if (candidates.length > 0) {
          v = candidates[0];
          reason = 'steal';
        }
      }
      if (v < 0) {
        diagnostics.push({
          kind: 'noteDropped',
          severity: 'error',
          message: `${describe(note)} was dropped: all voices are busy with higher-priority notes.`,
          source: note.keyOn.source,
          tick,
        });
        continue;
      }

      const old = state[v].note;
      if (old && (reason === 'steal' || reason === 'limit') && !isFree(v, tick) && !inRelease(v, tick) && old.heldEnd > tick) {
        diagnostics.push({
          kind: 'voiceStolen',
          severity: 'warning',
          message: `Voice ${v} taken from ${describe(old)} by ${describe(note)}${reason === 'limit' ? ' (device voice limit)' : ''}.`,
          source: old.keyOn.source,
          tick,
          voice: v,
        });
        const k = keyOnOut.get(old.id);
        if (k) k.stolen = true;
      }

      state[v] = { note, seq: seq++, keyOffTick: Infinity, freeAt: note.naturalEnd };
      voiceOf.set(note.id, v);
      groupLast.set(note.group, note);
      const keyOn: KeyOnEvent = { ...note.keyOn };
      keyOnOut.set(note.id, keyOn);
      lanes[v].push(keyOn);
    }
  }
  recordUsageUntil(totalTicks);
  return { lanes, usedPerTick };
}

export function describeNote(n: LogicalNote, deviceName: string): string {
  return `${noteName(n.keyOn.note)} (${deviceName}, track ${n.track + 1})`;
}
