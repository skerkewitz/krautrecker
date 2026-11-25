import type { DspEnvelope } from '../dsp/sdsp';
import { COUNTER_RATES, DSP_RATE } from '../dsp/tables';
import type { Device, Release, Tremolo, Vibrato, Zone } from '../model/types';
import { toDspEnvelope } from './instrument';
import type { SourceRef, VoiceEvent } from './ir';

/**
 * Envelope and modulation rules of stage 2: the key-on envelope (ADSR or the device's GAIN byte),
 * the G effect, long releases through GAIN decrease modes, device and effect tremolo, and the
 * vibrato fade-in. `TrackProcessor` keeps one `EnvState` per note and calls in here, so the same
 * rules run in compiled playback and in live play.
 */

/** Per-note state for the rules in this module. */
export interface EnvState {
  /** GAIN byte set by the G effect; null = the device envelope. */
  gainFx: number | null;
  /** GAIN byte last sent to the voice, or null while it runs the key-on envelope. */
  sentGain: number | null;
  /** Current tremolo dip from the T effect, as a fraction of full volume (0..1). */
  tremFx: number;
  tremPhase: number;
}

export function newEnvState(): EnvState {
  return { gainFx: null, sentGain: null, tremFx: 0, tremPhase: 0 };
}

// ---------------------------------------------------------------- envelopes

/**
 * The envelope a note keys on with. A device GAIN byte replaces the ADSR envelope, including a
 * zone's ADSR override, because it is the device-wide choice of envelope hardware. A G effect on
 * the note's own line wins over both.
 */
export function keyOnEnvelope(device: Device, zone: Zone, st: EnvState): DspEnvelope {
  const gain = st.gainFx ?? device.gain;
  st.sentGain = gain;
  if (gain !== null) return { mode: 'gain', gain: gain & 0xff };
  return toDspEnvelope(zone.envelope ?? device.envelope);
}

/** The envelope switch a G effect asks for since the last emit, or null. */
export function envelopeChange(st: EnvState): DspEnvelope | null {
  if (st.gainFx === null || st.gainFx === st.sentGain) return null;
  st.sentGain = st.gainFx;
  return { mode: 'gain', gain: st.gainFx & 0xff };
}

/** G effect: the sounding note switches to this raw GAIN byte until it ends. */
export function gainEffect(st: EnvState, value: number): void {
  st.gainFx = value & 0xff;
}

// ---------------------------------------------------------------- GAIN timing

/** Highest envelope level (11 bits). */
const ENV_MAX = 0x7ff;

/** Envelope steps one GAIN mode needs to cross the full range, by the S-DSP's arithmetic. */
function countSteps(step: (env: number) => number, from: number, done: (env: number) => boolean): number {
  let env = from;
  let steps = 0;
  while (!done(env)) {
    env = step(env);
    steps++;
  }
  return steps;
}

const LINEAR_DOWN_STEPS = countSteps((e) => e - 0x20, ENV_MAX, (e) => e <= 0);
const EXP_DOWN_STEPS = countSteps(
  (e) => {
    e--;
    return e - (e >> 8);
  },
  ENV_MAX,
  (e) => e <= 0,
);
const LINEAR_UP_STEPS = countSteps((e) => e + 0x20, 0, (e) => e >= ENV_MAX);
// Bent line: +0x20 per step up to 0x600, then +8 (the S-DSP compares the previous level).
const BENT_UP_STEPS = countSteps((e) => e + (e >= 0x600 ? 8 : 0x20), 0, (e) => e >= ENV_MAX);

/** Samples a GAIN slope at `rate` needs for `steps` envelope steps (worst case of the counter phase). */
function slopeSamples(rate: number, steps: number): number {
  const r = Math.max(0, Math.min(31, Math.round(rate)));
  return r === 0 ? Infinity : steps * COUNTER_RATES[r];
}

/** Samples from note-off to silence, assuming the envelope was at its maximum. Hardware key-off: 256. */
export function releaseSamples(release: Release): number {
  if (release.mode === 'hardware') return Math.ceil(ENV_MAX / 8);
  const rate = Math.max(1, Math.min(31, Math.round(release.rate)));
  return slopeSamples(rate, release.mode === 'linear' ? LINEAR_DOWN_STEPS : EXP_DOWN_STEPS);
}

/** The GAIN byte a release mode switches to at note-off. */
export function releaseGain(release: Release): number {
  const rate = Math.max(1, Math.min(31, Math.round(release.rate)));
  return (release.mode === 'linear' ? 0x80 : 0xa0) | rate;
}

/**
 * Events for a note-off (not a cut). 'hardware' keys off at once. 'exp' / 'linear' switch the
 * voice to a GAIN decrease and key it off only once the envelope has surely reached zero, which
 * is how SNES drivers get releases longer than the fixed 8 ms of key-off. The time assumes the
 * worst case, level 0x7FF at note-off, plus one sample for tick rounding.
 */
export function releaseEvents(release: Release, tick: number, source: SourceRef, samplesPerTick: number): VoiceEvent[] {
  if (release.mode === 'hardware') return [{ tick, type: 'keyOff', source }];
  const ticks = Math.max(1, Math.ceil((releaseSamples(release) + 1) / samplesPerTick));
  return [
    { tick, type: 'setEnvelope', envelope: { mode: 'gain', gain: releaseGain(release) }, release: true, source },
    // A driver times this key-off itself, so it does not count as song data.
    { tick: tick + ticks, type: 'keyOff', source, auto: true },
  ];
}

// ---------------------------------------------------------------- modulation

/** Device vibrato in semitones at a note's age (ticks since key-on), with the fade-in ramp. */
export function vibratoOffset(v: Vibrato | null, age: number): number {
  if (!v || v.depth <= 0 || age < v.delay) return 0;
  const t = age - v.delay;
  const wave = Math.sin((2 * Math.PI * t) / Math.max(1, v.rate));
  if (v.fadeIn > 0 && t < v.fadeIn) return v.depth * (t / v.fadeIn) * wave;
  return v.depth * wave;
}

/**
 * Tremolo only ever lowers the volume: the dip follows (1 - cos) / 2, so it starts smoothly at the
 * note's own volume, reaches `depth` below full volume at the trough, and never clips at 127.
 */
function dip(depth: number, phase: number, period: number): number {
  return (Math.max(0, Math.min(127, depth)) / 127) * ((1 - Math.cos((2 * Math.PI * phase) / Math.max(1, period))) / 2);
}

/** Device tremolo dip (fraction of full volume) at a note's age. */
export function tremoloDip(t: Tremolo | null, age: number): number {
  if (!t || t.depth <= 0 || age < t.delay) return 0;
  return dip(t.depth, age - t.delay, t.rate);
}

/** T effect for one tick: x = depth in 8-volume-unit steps, y = period in 2-tick units. */
export function tremoloEffect(st: EnvState, value: number): void {
  st.tremFx = dip((value >> 4) * 8, st.tremPhase, Math.max(1, value & 15) * 2);
  st.tremPhase++;
}

/** A line without a T effect ends the effect's tremolo, as with vibrato. */
export function resetTremoloEffect(st: EnvState): void {
  st.tremFx = 0;
  st.tremPhase = 0;
}

/** Applies a tremolo dip to a voice volume (0..127). Without a dip the volume is unchanged. */
export function applyTremolo(volume: number, dipFraction: number): number {
  if (dipFraction <= 0) return volume;
  return Math.round(volume * Math.max(0, 1 - dipFraction));
}

// ---------------------------------------------------------------- descriptions (UI)

/** Seconds a GAIN slope takes across the full range at a rate, for labels. */
function seconds(rate: number, steps: number): number {
  return slopeSamples(rate, steps) / DSP_RATE;
}

/** Seconds from note-off to silence (worst case), for labels. */
export function releaseSeconds(release: Release): number {
  return releaseSamples(release) / DSP_RATE;
}

export function formatSeconds(s: number): string {
  if (!Number.isFinite(s)) return 'never';
  if (s >= 1) return `${s.toFixed(1)} s`;
  return `${Math.max(1, Math.round(s * 1000))} ms`;
}

/** A readable description of a raw GAIN byte, as used for a note's envelope. */
export function describeGain(byte: number): string {
  const b = byte & 0xff;
  const rate = b & 0x1f;
  if (b < 0x80) {
    const level = b & 0x7f;
    return `Direct: holds level ${level}/127 (${Math.round((level / 127) * 100)} %) from key-on, no attack.`;
  }
  const silentNote = 'At key-on the envelope starts at 0, so as a note envelope this stays silent; use it with the G effect.';
  if (rate === 0) return `${['Linear decrease', 'Exponential decrease', 'Linear increase', 'Bent-line increase'][(b >> 5) - 4]}, rate 0: the level never changes, so a note keyed on with it stays silent.`;
  switch (b >> 5) {
    case 4:
      return `Linear decrease, rate ${rate}: full to silent in ${formatSeconds(seconds(rate, LINEAR_DOWN_STEPS))}. ${silentNote}`;
    case 5:
      return `Exponential decrease, rate ${rate}: full to silent in ${formatSeconds(seconds(rate, EXP_DOWN_STEPS))}. ${silentNote}`;
    case 6:
      return `Linear increase, rate ${rate}: silent to full in ${formatSeconds(seconds(rate, LINEAR_UP_STEPS))}, then holds.`;
    default:
      return `Bent-line increase, rate ${rate}: fast to 3/4, then slower; silent to full in ${formatSeconds(seconds(rate, BENT_UP_STEPS))}, then holds.`;
  }
}
