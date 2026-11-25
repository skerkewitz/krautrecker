import { int16ToBase64 } from '../util/base64';
import { mulberry32 } from '../util/prng';
import { emptyProject, newDevice, newPattern, newTrack, newZone } from './defaults';
import type { Cell, Pattern, Project, Sample } from './types';

/**
 * A small demo song with synthesized samples, so the tracker makes sound before the user has
 * imported anything. Everything is generated deterministically (seeded noise), which also makes
 * the demo a handy compiler test fixture.
 */

const RATE = 32000;

function toInt16(data: Float64Array, gain = 0.8): Int16Array {
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0 ? (gain * 32767) / peak : 0;
  return Int16Array.from(data, (v) => Math.round(v * scale));
}

/** One band-limited cycle of `n` samples. Odd-only harmonics give a square, all give a saw. */
function cycle(n: number, harmonics: number, oddOnly: boolean): Int16Array {
  const out = new Float64Array(n);
  for (let h = 1; h <= harmonics; h++) {
    if (oddOnly && h % 2 === 0) continue;
    for (let i = 0; i < n; i++) out[i] += Math.sin((2 * Math.PI * h * i) / n) / h;
  }
  return toInt16(out, 0.7);
}

/** Root note and fine tune (cents) for a waveform whose cycle is `n` samples at 32 kHz. */
function tuning(n: number): { rootNote: number; fineTune: number } {
  const exact = 69 + 12 * Math.log2(RATE / n / 440);
  const rootNote = Math.round(exact);
  return { rootNote, fineTune: Math.round((rootNote - exact) * 100) };
}

function waveSample(id: string, name: string, n: number, harmonics: number, oddOnly: boolean): Sample {
  return {
    id,
    name,
    pcm: int16ToBase64(cycle(n, harmonics, oddOnly)),
    sampleRate: RATE,
    targetRate: RATE,
    ...tuning(n),
    loop: { enabled: true, start: 0 },
  };
}

function drumSample(id: string, name: string, seconds: number, fn: (t: number, i: number, rnd: () => number) => number, targetRate = RATE): Sample {
  const rnd = mulberry32(0x5eed ^ id.length);
  const n = Math.round(seconds * RATE);
  const data = new Float64Array(n);
  for (let i = 0; i < n; i++) data[i] = fn(i / RATE, i, rnd);
  return { id, name, pcm: int16ToBase64(toInt16(data, 0.9)), sampleRate: RATE, targetRate, rootNote: 60, fineTune: 0, loop: { enabled: false, start: 0 } };
}

export function demoSamples(): Sample[] {
  let phase = 0;
  let lastNoise = 0;
  return [
    waveSample('smp_saw_lo', 'Saw low', 128, 30, false),
    waveSample('smp_saw_hi', 'Saw high', 32, 12, false),
    waveSample('smp_square', 'Square', 64, 31, true),
    drumSample(
      'smp_kick',
      'Kick',
      0.35,
      (t) => {
        const f = 45 + 110 * Math.exp(-t * 30);
        phase += (2 * Math.PI * f) / RATE;
        return Math.sin(phase) * Math.exp(-t * 9);
      },
      16000,
    ),
    drumSample('smp_snare', 'Snare', 0.25, (t, _i, rnd) => (rnd() * 2 - 1) * Math.exp(-t * 18) + 0.5 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 30)),
    drumSample('smp_hat_closed', 'Hat closed', 0.07, (t, _i, rnd) => {
      const n = rnd() * 2 - 1;
      const hp = n - lastNoise;
      lastNoise = n;
      return hp * Math.exp(-t * 60);
    }),
    drumSample('smp_hat_open', 'Hat open', 0.4, (t, _i, rnd) => {
      const n = rnd() * 2 - 1;
      const hp = n - lastNoise;
      lastNoise = n;
      return hp * Math.exp(-t * 7);
    }),
  ];
}

const KICK = 36;
const SNARE = 38;
const HAT_CLOSED = 42;
const HAT_OPEN = 46;

function put(p: Pattern, track: number, line: number, column: number, cell: Cell): void {
  p.tracks[track].cells[line][column] = cell;
}

const CHORDS = [
  { notes: [57, 60, 64], bass: 33 }, // A minor
  { notes: [57, 60, 65], bass: 29 }, // F major
  { notes: [55, 60, 64], bass: 36 }, // C major
  { notes: [55, 59, 62], bass: 31 }, // G major
];

function demoPattern(id: string, name: string, variation: boolean): Pattern {
  const p = newPattern(name, 64, [newTrack('dev_drums', 2, 64), newTrack('dev_bass', 1, 64), newTrack('dev_arp', 3, 64), newTrack('dev_pad', 3, 64)], id);
  for (let bar = 0; bar < 4; bar++) {
    const base = bar * 16;
    const chord = CHORDS[bar];
    // Drums: kick and snare in column 0, hats in column 1 (closed hats choke the open hat).
    for (const l of [0, 8, 10]) put(p, 0, base + l, 0, { note: KICK });
    for (const l of [4, 12]) put(p, 0, base + l, 0, { note: SNARE });
    for (let l = 0; l < 16; l += 2) put(p, 0, base + l, 1, { note: l === 14 ? HAT_OPEN : HAT_CLOSED, volume: l % 4 === 0 ? 100 : 70 });
    if (variation && bar === 3) for (const l of [14, 15]) put(p, 0, base + l, 0, { note: SNARE, volume: 60 + l * 4 });
    // Bass: eighth notes, root and octave.
    for (let l = 0; l < 16; l += 2) put(p, 1, base + l, 0, { note: chord.bass + (l % 4 === 2 ? 12 : 0), volume: l % 4 === 0 ? 127 : 96 });
    // Arp: the chord one octave up, held for the bar.
    chord.notes.forEach((n, c) => put(p, 2, base, c, { note: n + 12, volume: 90 }));
    // Pad: the chord, softer; the variation adds a slide-up into the next bar.
    chord.notes.forEach((n, c) => put(p, 3, base, c, { note: n, volume: 80 }));
    if (variation) put(p, 3, base + 15, 0, { fx: [{ type: 'vibrato', value: 0x23 }] });
  }
  return p;
}

export function demoProject(): Project {
  const project = emptyProject();
  project.title = 'Krautrecker demo';
  project.samples = demoSamples();

  const drums = newDevice('Drums', 'drum', [], 'dev_drums');
  drums.maxVoices = 3;
  drums.priority = 200;
  drums.zones = [
    { ...newZone('smp_kick', [KICK, KICK]), fixedPitch: 60 },
    { ...newZone('smp_snare', [SNARE, SNARE]), fixedPitch: 60 },
    { ...newZone('smp_hat_closed', [HAT_CLOSED, HAT_CLOSED]), fixedPitch: 60, chokeGroup: 1, volume: 90 },
    { ...newZone('smp_hat_open', [HAT_OPEN, HAT_OPEN]), fixedPitch: 60, chokeGroup: 1, volume: 90 },
  ];

  const bass = newDevice('Bass', 'mono', [newZone('smp_saw_lo')], 'dev_bass');
  bass.priority = 180;
  bass.envelope = { attack: 15, decay: 5, sustainLevel: 4, sustainRate: 12 };

  const arp = newDevice('Arp lead', 'arp', [newZone('smp_saw_lo', [0, 71]), newZone('smp_saw_hi', [72, 127])], 'dev_arp');
  arp.arp = { rate: 3, direction: 'up', octaves: 2 };
  arp.volume = 70;
  arp.echo = true;
  arp.pan = -20;

  const pad = newDevice('Pad', 'poly', [newZone('smp_square')], 'dev_pad');
  pad.maxVoices = 3;
  pad.priority = 100;
  pad.volume = 60;
  pad.pan = 20;
  pad.echo = true;
  pad.envelope = { attack: 9, decay: 3, sustainLevel: 5, sustainRate: 0 };
  pad.vibrato = { depth: 0.08, rate: 24, delay: 12, fadeIn: 0 };

  project.devices = [drums, bass, arp, pad];
  const a = demoPattern('pat_a', 'Groove', false);
  const b = demoPattern('pat_b', 'Groove + fill', true);
  project.patterns = [a, b];
  project.order = [a.id, a.id, b.id];
  project.hardware.echo = { delay: 5, feedback: 50, volumeL: 40, volumeR: 40, fir: [96, 16, 8, 4, 2, 1, 0, 0], writeEnabled: true };
  project.hardware.mainVolumeL = 90;
  project.hardware.mainVolumeR = 90;
  return project;
}
