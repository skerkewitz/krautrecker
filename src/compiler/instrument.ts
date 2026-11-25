import type { BuiltSample } from '../brr/sampleBuild';
import type { DspEnvelope } from '../dsp/sdsp';
import { DSP_RATE } from '../dsp/tables';
import type { Device, Envelope, Sample, Zone } from '../model/types';

/** Largest value of the 14-bit pitch register: just under 4x, so about +2 octaves. */
export const MAX_PITCH = 0x3fff;

export interface ZoneMatch {
  zone: Zone;
  /** False when no range contained the note and the nearest root note was used instead. */
  exact: boolean;
}

/**
 * Picks the zone for a note: the first zone whose key range contains it. If none does, the zone
 * with the nearest root note is used and the caller emits a warning.
 */
export function selectZone(device: Device, note: number, samples: Map<string, Sample>): ZoneMatch | null {
  if (device.zones.length === 0) return null;
  for (const zone of device.zones) {
    if (note >= zone.keyRange[0] && note <= zone.keyRange[1]) return { zone, exact: true };
  }
  let best = device.zones[0];
  let bestDist = Infinity;
  for (const zone of device.zones) {
    const root = zoneRoot(zone, samples);
    const dist = Math.abs(root - note);
    if (dist < bestDist) {
      best = zone;
      bestDist = dist;
    }
  }
  return { zone: best, exact: false };
}

export function zoneRoot(zone: Zone, samples: Map<string, Sample>): number {
  return zone.rootNoteOverride ?? samples.get(zone.sampleId)?.rootNote ?? 60;
}

/**
 * Pitch register value for playing `note` (fractional semitones allowed) on a zone.
 * 0x1000 plays the BRR data at 32 kHz, so a sample encoded at `effectiveRate` plays at its root
 * note with 0x1000 * effectiveRate / 32000. Fine tune shifts playback by cents.
 */
export function pitchFor(note: number, root: number, fineTune: number, built: BuiltSample): { pitch: number; clamped: boolean } {
  const semis = note - root + fineTune / 100;
  const raw = Math.round(0x1000 * (built.effectiveRate / DSP_RATE) * Math.pow(2, semis / 12));
  if (raw > MAX_PITCH) return { pitch: MAX_PITCH, clamped: true };
  if (raw < 1) return { pitch: 1, clamped: true };
  return { pitch: raw, clamped: false };
}

export function toDspEnvelope(e: Envelope): DspEnvelope {
  return { mode: 'adsr', attack: e.attack, decay: e.decay, sustainLevel: e.sustainLevel, sustainRate: e.sustainRate };
}

/**
 * Left/right voice volume (signed 8-bit registers, 0..127 used here). The pan law keeps the
 * centre at full volume on both sides and attenuates only the far side, so panning never makes
 * a voice quieter than centred.
 */
export function stereoVolume(volume: number, pan: number): { volL: number; volR: number } {
  const v = Math.max(0, Math.min(127, volume));
  const p = Math.max(-64, Math.min(63, pan));
  return {
    volL: p <= 0 ? v : Math.round((v * (63 - p)) / 63),
    volR: p >= 0 ? v : Math.round((v * (64 + p)) / 64),
  };
}

/**
 * Number of samples until a one-shot sample ends at a given pitch, or Infinity if it loops.
 * Lets the allocator treat the voice as free once a drum hit has finished.
 */
export function playLengthSamples(built: BuiltSample, pitch: number): number {
  if (built.loopBlock >= 0) return Infinity;
  return Math.ceil((built.length * 0x1000) / Math.max(1, pitch));
}
