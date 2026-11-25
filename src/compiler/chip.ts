import type { BuiltSample } from '../brr/sampleBuild';
import { noiseFrequency } from '../dsp/noise';
import type { Device, Sample, Zone } from '../model/types';
import type { VoiceAllocator } from './allocate';
import type { ExpandContext, LogicalNote } from './expand';
import type { Diagnostic, GlobalEvent, SourceRef, VoiceEvent } from './ir';
import { VOICE_COUNT } from './ir';

/**
 * Chip voice features: noise (NON + the global noise clock), pitch modulation (PMON) and
 * surround. Stage 2 marks which notes want them; stage 3 (`ChipVoices`, run next to the
 * `VoiceAllocator` by the compiler and by live play) turns that into register events per voice,
 * because NON and PMON are per-voice register bits that outlive the note that set them.
 */

// ---------------------------------------------------------------- stage 2

/** A zone's noise clock (0..31), or null when the zone plays its sample. */
export function zoneNoiseClock(zone: Zone): number | null {
  return zone.noise === undefined ? null : Math.max(0, Math.min(31, Math.round(zone.noise)));
}

/** Effect N: 00-1F switch the note to noise at that clock, 20-FF switch noise off. */
export function noiseEffectClock(value: number): number | null {
  return value >= 0 && value <= 0x1f ? value : null;
}

/** Surround inverts the right channel's phase: a negative right volume register. */
export function withSurround<T extends { volL: number; volR: number }>(device: Pick<Device, 'surround'>, vol: T): T {
  return device.surround && vol.volR !== 0 ? { ...vol, volR: -vol.volR } : vol;
}

/** The parts of a stage-2 note that noise switching touches. */
export interface NoiseTarget {
  ln: LogicalNote | null;
  noise: number | null;
  source: SourceRef;
  device: Device;
  sample: Sample;
  built: BuiltSample;
}

/** Approximate step rate of a noise clock, for the UI: "1.3 kHz", "16 Hz", "off". */
export function formatNoiseRate(clock: number): string {
  const hz = noiseFrequency(clock);
  if (hz === 0) return 'off';
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}

/** Noise clock with its approximate rate, for messages. */
export function describeNoiseClock(clock: number): string {
  return `${clock} (${formatNoiseRate(clock)})`;
}

function diagnoseOneShot(ctx: ExpandContext, a: NoiseTarget, tick: number): void {
  if (a.built.loopBlock >= 0) return;
  const key = `noiseoneshot:${a.device.id}:${a.sample.id}`;
  if (ctx.diagKeys.has(key)) return;
  ctx.diagKeys.add(key);
  ctx.diagnostics.push({
    kind: 'noiseOneShot',
    severity: 'info',
    category: 'hardware',
    message: `"${a.device.name}" plays noise over the one-shot sample "${a.sample.name}". A noise voice still runs its sample, so the noise stops when the sample ends; loop the sample for sustained noise.`,
    source: a.source,
    tick,
  });
}

/** Fills in a new logical note's chip fields from its stage-2 state and device. */
export function initChipNote(ctx: ExpandContext, ln: LogicalNote, a: NoiseTarget, tick: number): void {
  if (a.noise !== null) {
    ln.noise = a.noise;
    diagnoseOneShot(ctx, a, tick);
  }
  const src = a.device.pitchModSource;
  if (src && ctx.devices.has(src)) ln.pitchModSource = src;
}

/** Effect N on a sounding note: switches it to noise at `clock`, or back to its sample (null). */
export function switchNoise(ctx: ExpandContext, a: NoiseTarget, clock: number | null, tick: number): void {
  if (a.noise === clock) return;
  a.noise = clock;
  if (clock !== null) diagnoseOneShot(ctx, a, tick);
  // Before the note's key-on the new state simply goes into the key-on (see initChipNote).
  if (!a.ln) return;
  a.ln.events.push(clock === null ? { tick, type: 'noise', enabled: false, source: a.source } : { tick, type: 'noise', enabled: true, clock, source: a.source });
}

// ---------------------------------------------------------------- stage 3

/**
 * Sort key for new notes within a tick: pitch-modulated notes go last, so their source notes
 * already have voices when they look for the voice just above one.
 */
export function pitchModRank(n: LogicalNote): number {
  return n.pitchModSource ? 1 : 0;
}

/**
 * Marks the notes of one tick whose device is the pitch-modulation source of another note on the
 * same tick. The allocator then seats each such modulator where the voice above it is free, so the
 * modulated note can take that voice. Without this, the modulator takes the lowest free voice and
 * its neighbour is often busy.
 */
export function markPitchModPairs(requests: LogicalNote[]): void {
  const sources = new Set(requests.map((n) => n.pitchModSource).filter((s): s is string => !!s));
  for (const n of requests) n.pairAbove = sources.has(n.deviceId);
}

/**
 * Voice placement for a pitch-modulated note: a voice v >= 1 whose voice v-1 plays a note of the
 * source device. Free voices first, then voices whose note is only releasing; it never cuts a held
 * note for this. Returns -1 when no voice qualifies, and the normal rules apply.
 */
export function pitchModVoice(alloc: VoiceAllocator, usable: number[], note: LogicalNote, tick: number): number {
  let best = -1;
  let bestRank = 2;
  for (const u of usable) {
    if (u < 1 || alloc.noteAt(u - 1, tick)?.deviceId !== note.pitchModSource) continue;
    const rank = alloc.isFree(u, tick) ? 0 : alloc.heldNoteAt(u, tick) === null ? 1 : 2;
    if (rank < bestRank) {
      best = u;
      bestRank = rank;
    }
  }
  return best;
}

export interface ChipSink {
  voice(voice: number, ev: VoiceEvent): void;
  global(ev: GlobalEvent): void;
  /** Absent in live play, which shows no diagnostics. */
  diagnostic?(d: Diagnostic): void;
}

/**
 * Tracks the NON and PMON bits of the eight voices and emits the events that keep them right.
 *
 * At every key-on, a noise note gets `noise` on and writes its clock, and a pitch-modulated note
 * placed above its source gets `pitchMod` on. Both are sent even when the bit is already set,
 * because the player resets the bits when playback starts or loops (`SDsp.silence`). A voice whose
 * bit is set but whose new note does not want it gets the bit cleared. When a voice changes notes,
 * the voice above it is checked too: its PMON follows whether it still sits on its source device.
 */
export class ChipVoices {
  private noise: boolean[] = Array.from({ length: VOICE_COUNT }, () => false);
  /** The noise clock each voice's note asked for. */
  private clock: number[] = Array.from({ length: VOICE_COUNT }, () => -1);
  private pmon: boolean[] = Array.from({ length: VOICE_COUNT }, () => false);
  private lastWrite: { tick: number; clock: number; note: LogicalNote | null } = { tick: -1, clock: -1, note: null };
  private reported = new Set<string>();

  constructor(
    private readonly sink: ChipSink,
    private readonly describe: (n: LogicalNote) => string,
  ) {}

  /** A note just got voice `v` and its key-on was sent. */
  assigned(alloc: VoiceAllocator, note: LogicalNote, v: number, tick: number): void {
    const source = note.keyOn.source;
    if (note.noise !== undefined) {
      this.sink.voice(v, { tick, type: 'noise', enabled: true, clock: note.noise, source });
      this.noise[v] = true;
      this.clock[v] = note.noise;
      this.writeClock(alloc, note, v, note.noise, tick);
    } else if (this.noise[v]) {
      this.sink.voice(v, { tick, type: 'noise', enabled: false, source });
      this.noise[v] = false;
    }

    const modulator = v >= 1 ? alloc.noteAt(v - 1, tick) : null;
    if (note.pitchModSource && modulator?.deviceId === note.pitchModSource) {
      this.sink.voice(v, { tick, type: 'pitchMod', enabled: true, source });
      this.pmon[v] = true;
    } else {
      this.setPmon(v, false, tick, source);
      if (note.pitchModSource) {
        this.report(`pmod:${note.id}`, {
          kind: 'pitchModUnavailable',
          severity: 'warning',
          category: 'hardware',
          message: `${this.describe(note)} plays without pitch modulation: no voice was free directly above a voice playing its source device.`,
          source,
          tick,
          voice: v,
        });
      }
    }

    // The voice above may be modulated by this voice: keep its PMON in step with its source.
    const u = v + 1;
    if (u < VOICE_COUNT) {
      const above = alloc.noteAt(u, tick);
      const paired = !!above && above.pitchModSource === note.deviceId;
      if (this.pmon[u] && above && !paired) {
        this.setPmon(u, false, tick, above.keyOn.source);
        if (above.pitchModSource && alloc.heldNoteAt(u, tick)) {
          this.report(`pmodlost:${above.id}:${note.id}`, {
            kind: 'pitchModUnavailable',
            severity: 'warning',
            category: 'hardware',
            message: `${this.describe(above)} loses its pitch modulation: ${this.describe(note)} took the voice below it.`,
            source: above.keyOn.source,
            tick,
            voice: u,
          });
        }
      } else if (!this.pmon[u] && paired && alloc.heldNoteAt(u, tick)) {
        this.setPmon(u, true, tick, above!.keyOn.source);
      }
    }
  }

  /** One of a note's own events was sent to voice `v`. */
  routed(alloc: VoiceAllocator, note: LogicalNote, v: number, ev: VoiceEvent, tick: number): void {
    if (ev.type !== 'noise') return;
    this.noise[v] = ev.enabled;
    if (ev.enabled && ev.clock !== undefined) {
      this.clock[v] = ev.clock;
      this.writeClock(alloc, note, v, ev.clock, tick);
    }
  }

  private setPmon(v: number, enabled: boolean, tick: number, source: SourceRef): void {
    if (this.pmon[v] === enabled) return;
    this.sink.voice(v, { tick, type: 'pitchMod', enabled, source });
    this.pmon[v] = enabled;
  }

  /**
   * Writes the global noise clock for a note. Across ticks the last write wins; within one tick
   * the first note (highest priority, then lowest track) keeps its clock.
   */
  private writeClock(alloc: VoiceAllocator, note: LogicalNote, v: number, clock: number, tick: number): void {
    const last = this.lastWrite;
    if (last.tick === tick && last.clock !== clock && last.note) {
      this.report(`noiseclk:${last.note.id}:${note.id}`, {
        kind: 'noiseClockConflict',
        severity: 'warning',
        category: 'hardware',
        message: `${this.describe(note)} wants noise clock ${describeNoiseClock(clock)}, but ${this.describe(last.note)} sets ${describeNoiseClock(last.clock)} on the same tick. The noise clock is global, so both play at ${describeNoiseClock(last.clock)}.`,
        source: note.keyOn.source,
        tick,
        voice: v,
      });
      return;
    }
    if (last.tick !== tick || last.clock !== clock) {
      this.sink.global({ tick, type: 'noiseClock', clock });
      this.lastWrite = { tick, clock, note };
    }
    for (let w = 0; w < VOICE_COUNT; w++) {
      if (w === v || !this.noise[w] || this.clock[w] === clock) continue;
      const other = alloc.heldNoteAt(w, tick);
      if (!other) continue;
      this.report(`noiseclk:${other.id}:${note.id}`, {
        kind: 'noiseClockConflict',
        severity: 'warning',
        category: 'hardware',
        message: `${this.describe(note)} sets the noise clock to ${describeNoiseClock(clock)} while ${this.describe(other)} plays noise at ${describeNoiseClock(this.clock[w])}. The noise clock is global, so the last write wins for both.`,
        source: note.keyOn.source,
        tick,
        voice: v,
      });
    }
  }

  private report(key: string, d: Diagnostic): void {
    if (!this.sink.diagnostic || this.reported.has(key)) return;
    this.reported.add(key);
    this.sink.diagnostic(d);
  }
}
