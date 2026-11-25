import type { BuiltSample } from '../brr/sampleBuild';
import type { IR, KeyOnEvent, SourceRef, VoiceEvent } from '../compiler/ir';
import { zoneRoot } from '../compiler/instrument';
import { DSP_RATE } from '../dsp/tables';
import type { Project, Sample, Zone } from '../model/types';
import type { Stereo } from './render';

/**
 * Measurements on rendered audio and on the IR. Pure functions over sample ranges, so the analysis
 * can measure the whole song, one section or one stem the same way.
 */

/** Levels below this are reported as this value (silence). */
export const FLOOR_DB = -120;

export function toDb(linear: number): number {
  return linear > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(linear)) : FLOOR_DB;
}

export interface Levels {
  /** RMS over both channels, dBFS (a full-scale square wave is 0 dBFS, a full-scale sine -3). */
  rmsDb: number;
  peakDb: number;
  /** Sum of squares over both channels: adds up across stems, used for shares. */
  energy: number;
}

export function levels(audio: Stereo, start: number, end: number): Levels {
  const { left, right } = audio;
  let energy = 0;
  let peak = 0;
  for (let i = start; i < end; i++) {
    const l = left[i];
    const r = right[i];
    energy += l * l + r * r;
    const al = Math.abs(l);
    const ar = Math.abs(r);
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
  }
  const n = Math.max(1, end - start);
  return { rmsDb: toDb(Math.sqrt(energy / (2 * n))), peakDb: toDb(peak), energy };
}

// ------------------------------------------------------------------ spectrum

export interface Band {
  name: string;
  /** Lower edge in Hz; the band runs to the next band's edge (the last to Nyquist). */
  from: number;
}

/** Four rough bands, two octaves each in the middle: bass, low mids, presence, air and hats. */
export const BANDS: Band[] = [
  { name: 'low', from: 0 },
  { name: 'lowmid', from: 200 },
  { name: 'highmid', from: 800 },
  { name: 'high', from: 3200 },
];

const FFT_SIZE = 2048;

/** In-place radix-2 FFT (re/im arrays of a power-of-two length). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const HANN = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
const BIN_BAND = Int8Array.from({ length: FFT_SIZE / 2 + 1 }, (_, k) => {
  const hz = (k * DSP_RATE) / FFT_SIZE;
  let b = 0;
  while (b + 1 < BANDS.length && hz >= BANDS[b + 1].from) b++;
  return b;
});

/**
 * Energy share of each band (fractions summing to 1; all zero for silence), from Hann-windowed
 * 2048-sample frames over both channels. Both channels count separately, so a surround voice
 * (right channel inverted) is not cancelled as it would be in a mono sum.
 */
export function bandShares(audio: Stereo, start: number, end: number): number[] {
  const energy = new Array<number>(BANDS.length).fill(0);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let f = start; f < end; f += FFT_SIZE) {
    const len = Math.min(FFT_SIZE, end - f);
    if (len < FFT_SIZE / 4 && f > start) break;
    for (const ch of [audio.left, audio.right]) {
      for (let i = 0; i < FFT_SIZE; i++) {
        re[i] = i < len ? ch[f + i] * HANN[i] : 0;
        im[i] = 0;
      }
      fft(re, im);
      // Skip the DC bin: it says nothing about the sound and the DSP adds no offset.
      for (let k = 1; k <= FFT_SIZE / 2; k++) energy[BIN_BAND[k]] += re[k] * re[k] + im[k] * im[k];
    }
  }
  const total = energy.reduce((a, b) => a + b, 0);
  return energy.map((e) => (total > 0 ? e / total : 0));
}

// ------------------------------------------------------------------ tuning

export interface PitchSample {
  track: number;
  tick: number;
  voice: number;
  /** The note the pitch register actually plays, in fractional semitones (MIDI numbers). */
  sounding: number;
  /** Deviation from the nearest equal-tempered semitone, in cents (-50..50). */
  cents: number;
  /** Key-on, or a pitch change to a new note on a sounding voice (legato). */
  kind: 'keyOn' | 'legato';
  source: SourceRef;
}

/**
 * The note a pitch register value plays on a zone, from the zone's sample tuning: the sample sounds
 * at its root note minus its fine tune at its native (effective) rate, and the register scales
 * that rate linearly (0x1000 = the BRR data at 32 kHz). This inverts `pitchFor`, so a device fine
 * tune shows up as a deviation.
 */
export function soundingNote(pitch: number, zone: Zone, samples: Map<string, Sample>, built: BuiltSample): number {
  const root = zoneRoot(zone, samples) - (samples.get(zone.sampleId)?.fineTune ?? 0) / 100;
  return root + 12 * Math.log2((pitch * DSP_RATE) / (0x1000 * built.effectiveRate));
}

function zoneFor(project: Project, keyOn: KeyOnEvent, sampleId: string): Zone | null {
  const device = project.devices.find((d) => d.id === keyOn.deviceId);
  const zones = device?.zones.filter((z) => z.sampleId === sampleId) ?? [];
  return zones.find((z) => keyOn.note >= z.keyRange[0] && keyOn.note <= z.keyRange[1]) ?? zones[0] ?? null;
}

const PITCH_FX = new Set(['porta', 'slideUp', 'slideDown', 'vibrato']);

/**
 * Pitch of every key-on and every legato note change, with its deviation from equal temperament.
 * Voices playing noise are skipped (their pitch register only sets how fast the silent gate
 * sample runs). A legato note change is a composer-written pitch change on the tick of a cell
 * with a note and no pitch effect; glides and vibrato in between are not notes.
 */
export function measurePitches(project: Project, ir: IR, built: BuiltSample[]): PitchSample[] {
  const samples = new Map(project.samples.map((s) => [s.id, s]));
  const builtById = new Map(built.map((b) => [b.sampleId, b]));
  const patterns = new Map(project.patterns.map((p) => [p.id, p]));
  const lineTick = new Map(ir.lines.map((l) => [`${l.orderIndex}:${l.line}`, l.tick]));
  const out: PitchSample[] = [];

  const isNoteChange = (ev: VoiceEvent): boolean => {
    if (ev.auto) return false;
    const s = ev.source;
    const cell = patterns.get(s.patternId)?.tracks[s.track]?.cells[s.line]?.[s.column];
    if (!cell || typeof cell.note !== 'number') return false;
    if (cell.fx?.some((f) => f && PITCH_FX.has(f.type))) return false;
    return ev.tick === (lineTick.get(`${s.orderIndex}:${s.line}`) ?? -1) + (cell.delay ?? 0);
  };

  ir.voices.forEach((lane, voice) => {
    let noise = false;
    let current: { keyOn: KeyOnEvent; zone: Zone; built: BuiltSample } | null = null;
    for (let i = 0; i < lane.length; ) {
      // All events of one tick first, so a noise switch next to its key-on is seen in any order.
      let j = i;
      while (j < lane.length && lane[j].tick === lane[i].tick) j++;
      const group = lane.slice(i, j);
      i = j;
      for (const ev of group) if (ev.type === 'noise') noise = ev.enabled;
      for (const ev of group) {
        if (ev.type === 'keyOn') {
          const sampleId = ir.sampleSlots[ev.sampleSlot];
          const zone = zoneFor(project, ev, sampleId);
          const b = builtById.get(sampleId);
          current = zone && b ? { keyOn: ev, zone, built: b } : null;
        }
        if (!current || noise) continue;
        let kind: PitchSample['kind'] | null = null;
        let pitch = 0;
        if (ev.type === 'keyOn') {
          kind = 'keyOn';
          pitch = ev.pitch;
        } else if (ev.type === 'setPitch' && isNoteChange(ev)) {
          kind = 'legato';
          pitch = ev.pitch;
        }
        if (!kind) continue;
        const sounding = soundingNote(pitch, current.zone, samples, current.built);
        out.push({ track: ev.source.track, tick: ev.tick, voice, sounding, cents: (sounding - Math.round(sounding)) * 100, kind, source: ev.source });
      }
    }
  });
  return out.sort((a, b) => a.tick - b.tick || a.voice - b.voice);
}

export interface TuningStats {
  notes: number;
  /** Of `notes`, how many were legato pitch changes rather than key-ons. */
  legato: number;
  meanCents: number;
  minCents: number;
  maxCents: number;
  /** The note furthest from equal temperament. */
  worst: PitchSample | null;
}

export function tuningStats(pitches: PitchSample[]): TuningStats {
  if (pitches.length === 0) return { notes: 0, legato: 0, meanCents: 0, minCents: 0, maxCents: 0, worst: null };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let worst = pitches[0];
  for (const p of pitches) {
    sum += p.cents;
    min = Math.min(min, p.cents);
    max = Math.max(max, p.cents);
    if (Math.abs(p.cents) > Math.abs(worst.cents)) worst = p;
  }
  return { notes: pitches.length, legato: pitches.filter((p) => p.kind === 'legato').length, meanCents: sum / pitches.length, minCents: min, maxCents: max, worst };
}
