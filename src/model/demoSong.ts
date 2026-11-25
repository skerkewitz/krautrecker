import { int16ToBase64 } from '../util/base64';
import { mulberry32 } from '../util/prng';
import { emptyProject, newDevice, newPattern, newTrack, newZone } from './defaults';
import { drumSample, RATE, toInt16, tuning, waveSample } from './demo';
import { FX_BY_LETTER } from './notes';
import type { Cell, CellNote, Device, Effect, Pattern, Project, Sample } from './types';
import { NOTE_OFF } from './types';

/**
 * "Autobahn 16 bit", the demo song the app loads: a motorik krautrock piece in E dorian that
 * shows the tracker's SNES features in musical use. Two intro patterns play once, then five
 * patterns loop. Everything, samples included, is generated deterministically.
 *
 * Voice plan (8 voices, no stealing): drums 2, hats 1, bass 1, arp 1, pad 3 in the main groove;
 * the lead takes one pad voice in A', the FM bell (carrier + silent modulator) takes the arp's
 * voice and one pad voice in B.
 */

// ------------------------------------------------------------------ samples

/** Three detuned saws that loop seamlessly: 63, 64 and 65 cycles in 8192 samples (about 250 Hz). */
function stringsSample(): Sample {
  const n = 8192;
  const data = new Float64Array(n);
  for (const cycles of [63, 64, 65]) {
    for (let h = 1; h <= 14; h++) {
      const amp = 1 / h;
      for (let i = 0; i < n; i++) data[i] += amp * Math.sin((2 * Math.PI * h * cycles * i) / n);
    }
  }
  return {
    id: 'smp_strings',
    name: 'Strings',
    pcm: int16ToBase64(toInt16(data, 0.7)),
    sampleRate: RATE,
    targetRate: RATE,
    ...tuning(n / 64),
    loop: { enabled: true, start: 0 },
  };
}

/** A silent one-shot: under a noise voice it only decides how long the noise may sound. */
function gateSample(id: string, name: string, seconds: number): Sample {
  const rate = 8000;
  return {
    id,
    name,
    pcm: int16ToBase64(new Int16Array(Math.round(seconds * rate))),
    sampleRate: rate,
    targetRate: rate,
    rootNote: 60,
    fineTune: 0,
    loop: { enabled: false, start: 0 },
  };
}

function samples(): Sample[] {
  let phase = 0;
  return [
    waveSample('smp_saw_lo', 'Saw low', 128, 30, false),
    // Saw high plays up to G6 (8 semitones above its root): 9 harmonics stay below 16 kHz.
    waveSample('smp_saw_hi', 'Saw high', 32, 9, false),
    // The lead square plays up to A5 (10 semitones up): odd harmonics up to the 17th stay below 16 kHz.
    waveSample('smp_square', 'Square', 64, 17, true),
    waveSample('smp_sine', 'Sine', 64, 1, false),
    stringsSample(),
    drumSample(
      'smp_kick',
      'Kick',
      0.32,
      (t) => {
        const f = 48 + 140 * Math.exp(-t * 38);
        phase += (2 * Math.PI * f) / RATE;
        const click = t < 0.004 ? (1 - t / 0.004) * 0.6 : 0;
        return Math.sin(phase) * Math.exp(-t * 10) + click;
      },
      16000,
    ),
    (() => {
      const rnd = mulberry32(0x5a7e);
      return drumSample(
        'smp_snare',
        'Snare',
        0.22,
        (t) => (rnd() * 2 - 1) * Math.exp(-t * 20) * 0.8 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 35),
        16000,
      );
    })(),
    gateSample('smp_gate_short', 'Gate short (noise)', 0.07),
    gateSample('smp_gate_long', 'Gate long (noise)', 0.38),
  ];
}

// ------------------------------------------------------------------ devices

const KICK = 36;
const SNARE = 38;
const HAT = 42;
const HAT_OPEN = 46;

function devices(): Device[] {
  const drums = newDevice('Drums', 'drum', [], 'dev_drums');
  drums.zones = [
    { ...newZone('smp_kick', [KICK, KICK]), fixedPitch: 60 },
    { ...newZone('smp_snare', [SNARE, SNARE]), fixedPitch: 60, volume: 112, chokeGroup: 2 },
  ];
  drums.maxVoices = 2;
  drums.priority = 220;
  drums.volume = 112;

  // Hi-hats from the noise generator. The silent one-shot under each zone sets the length.
  const hats = newDevice('Noise hats', 'drum', [], 'dev_hats');
  hats.zones = [
    { ...newZone('smp_gate_short', [HAT, HAT]), fixedPitch: 60, noise: 29, chokeGroup: 1, envelope: { attack: 15, decay: 6, sustainLevel: 1, sustainRate: 22 } },
    { ...newZone('smp_gate_long', [HAT_OPEN, HAT_OPEN]), fixedPitch: 60, noise: 29, chokeGroup: 1, envelope: { attack: 15, decay: 4, sustainLevel: 3, sustainRate: 19 } },
  ];
  hats.maxVoices = 1;
  hats.priority = 210;
  hats.volume = 60;
  hats.pan = 12;

  const bass = newDevice('Motor bass', 'mono', [newZone('smp_saw_lo')], 'dev_bass');
  bass.envelope = { attack: 15, decay: 5, sustainLevel: 3, sustainRate: 12 };
  bass.priority = 200;
  bass.volume = 100;

  const arp = newDevice('Arp', 'arp', [newZone('smp_saw_lo', [0, 71]), newZone('smp_saw_hi', [72, 127])], 'dev_arp');
  arp.arp = { rate: 6, direction: 'upDown', octaves: 2 };
  arp.envelope = { attack: 15, decay: 6, sustainLevel: 3, sustainRate: 14 };
  arp.priority = 150;
  arp.volume = 58;
  arp.pan = -22;
  arp.echo = true;

  const pad = newDevice('Strings', 'poly', [newZone('smp_strings')], 'dev_pad');
  pad.maxVoices = 3;
  pad.envelope = { attack: 7, decay: 2, sustainLevel: 5, sustainRate: 0 };
  pad.release = { mode: 'exp', rate: 18 };
  pad.priority = 100;
  pad.volume = 52;
  pad.surround = true;
  pad.echo = true;

  const lead = newDevice('Lead', 'legato', [newZone('smp_square')], 'dev_lead');
  lead.legatoPortamento = 0;
  lead.vibrato = { depth: 0.12, rate: 24, delay: 30, fadeIn: 24 };
  lead.release = { mode: 'linear', rate: 12 };
  lead.envelope = { attack: 13, decay: 7, sustainLevel: 7, sustainRate: 0 };
  lead.priority = 190;
  lead.volume = 50;
  lead.pan = 10;
  lead.echo = true;

  // FM bell: a silent sine modulates the audible sine on the voice above it (pitch modulation).
  // Its own envelope decays faster, so the bell starts bright and mellows.
  const bellMod = newDevice('Bell modulator', 'mono', [newZone('smp_sine')], 'dev_bellmod');
  bellMod.volume = 0;
  bellMod.envelope = { attack: 15, decay: 3, sustainLevel: 2, sustainRate: 9 };
  bellMod.priority = 230;

  const bell = newDevice('FM bell', 'mono', [newZone('smp_sine')], 'dev_bell');
  bell.pitchModSource = 'dev_bellmod';
  bell.envelope = { attack: 15, decay: 5, sustainLevel: 3, sustainRate: 11 };
  bell.release = { mode: 'exp', rate: 16 };
  bell.priority = 230;
  bell.volume = 78;
  bell.pan = -12;
  bell.echo = true;

  // Wind and riser: sustained noise with slow tremolo gusts.
  const wind = newDevice('Wind', 'mono', [{ ...newZone('smp_sine'), noise: 20 }], 'dev_wind');
  wind.envelope = { attack: 4, decay: 7, sustainLevel: 7, sustainRate: 0 };
  wind.release = { mode: 'exp', rate: 18 };
  wind.tremolo = { depth: 34, rate: 40, delay: 0 };
  wind.priority = 120;
  wind.volume = 56;
  wind.echo = true;

  return [drums, hats, bass, arp, pad, lead, bellMod, bell, wind];
}

// ------------------------------------------------------------------ pattern helpers

const T = { drums: 0, hats: 1, bass: 2, arp: 3, pad: 4, lead: 5, bellMod: 6, bell: 7, wind: 8, cond: 9 } as const;
const TRACKS: [string | null, number][] = [
  ['dev_drums', 2],
  ['dev_hats', 1],
  ['dev_bass', 1],
  ['dev_arp', 3],
  ['dev_pad', 3],
  ['dev_lead', 1],
  ['dev_bellmod', 1],
  ['dev_bell', 1],
  ['dev_wind', 1],
  [null, 1], // conductor: tempo, volume and echo automation only
];
const LINES = 64;

const PITCH: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
/** Note name to MIDI number: 'E2' = 40, 'C4' = 60. */
function n(name: string): number {
  const m = /^([A-G]#?)(\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return (Number(m[2]) + 1) * 12 + PITCH[m[1]];
}

/** Effect from its letter, e.g. fx('H', 0x10). */
function fx(letter: string, value: number): Effect {
  const type = FX_BY_LETTER[letter];
  if (!type) throw new Error(`bad effect ${letter}`);
  return { type, value };
}

class Pat {
  readonly p: Pattern;
  constructor(id: string, name: string) {
    this.p = newPattern(
      name,
      LINES,
      TRACKS.map(([d, cols]) => newTrack(d, cols, LINES)),
      id,
    );
  }

  /** Writes into a cell, keeping what is there; effects fill the free effect columns. */
  put(track: number, line: number, col: number, cell: { note?: CellNote; volume?: number }, ...effects: Effect[]): this {
    const old: Cell = this.p.tracks[track].cells[line][col] ?? {};
    const list = [...(old.fx ?? []).filter((e): e is Effect => !!e), ...effects];
    if (list.length > 2) throw new Error(`more than two effects at track ${track} line ${line}`);
    const next: Cell = { ...old, ...cell };
    if (list.length) next.fx = list;
    this.p.tracks[track].cells[line][col] = next;
    return this;
  }

  note(track: number, line: number, col: number, note: CellNote, volume?: number, ...effects: Effect[]): this {
    return this.put(track, line, col, volume === undefined ? { note } : { note, volume }, ...effects);
  }

  fx(track: number, line: number, col: number, ...effects: Effect[]): this {
    return this.put(track, line, col, {}, ...effects);
  }

  chord(track: number, line: number, notes: number[], volume: number, ...effects: Effect[]): this {
    notes.forEach((note, c) => this.note(track, line, c, note, volume, ...effects));
    return this;
  }

  off(track: number, line: number, cols: number): this {
    for (let c = 0; c < cols; c++) this.note(track, line, c, NOTE_OFF);
    return this;
  }
}

// ------------------------------------------------------------------ musical material (E dorian)

/** Em, D/E, C/E, D/E over an E pedal: the harmonic loop of the whole piece. */
const PROG = [
  ['B3', 'E4', 'G4'],
  ['A3', 'D4', 'F#4'],
  ['G3', 'C4', 'E4'],
  ['A3', 'D4', 'F#4'],
].map((c) => c.map(n));

/** Motorik bass: driving eighths on the E pedal, with a turn at the end of each bar. */
const BASS: [number, string, number][] = [
  [0, 'E2', 0x7f],
  [2, 'E2', 0x50],
  [4, 'E3', 0x6c],
  [6, 'E2', 0x50],
  [8, 'E2', 0x7a],
  [10, 'E2', 0x50],
  [12, 'D3', 0x6c],
  [14, 'B2', 0x5c],
];

function motorik(p: Pat, bar: number, snare = true): void {
  const b = bar * 16;
  for (const l of [0, 4, 8, 12]) p.note(T.drums, b + l, 0, KICK, l === 0 ? 0x7f : 0x70);
  if (snare) for (const l of [4, 12]) p.note(T.drums, b + l, 1, SNARE, 0x6c);
}

function hats(p: Pat, bar: number): void {
  const b = bar * 16;
  for (let l = 0; l < 16; l += 2) p.note(T.hats, b + l, 0, l === 14 ? HAT_OPEN : HAT, l % 4 === 0 ? 0x7f : 0x58);
}

function bass(p: Pat, bar: number, ...effects: Effect[]): void {
  for (const [l, name, vol] of BASS) p.note(T.bass, bar * 16 + l, 0, n(name), vol, ...effects);
}

/** The snare build-up: retriggered snares getting louder, continued by effect memory (R00, A00). */
function snareRoll(p: Pat): void {
  p.note(T.drums, 56, 1, SNARE, 0x38, fx('R', 0x03), fx('A', 0x10));
  for (const [l, v] of [
    [58, 0x48],
    [60, 0x58],
    [62, 0x68],
  ]) {
    p.note(T.drums, l, 1, SNARE, v, fx('R', 0x00), fx('A', 0x00));
  }
}

/** The main groove section: drums, noise hats, bass, arp and the pad (with `padVoices` voices). */
function groove(p: Pat, padVoices: number): void {
  for (let bar = 0; bar < 4; bar++) {
    motorik(p, bar);
    hats(p, bar);
    bass(p, bar);
    p.chord(T.arp, bar * 16, PROG[bar].map((x) => x + 12), 0x6c);
    p.chord(T.pad, bar * 16, PROG[bar].slice(3 - padVoices), 0x60);
  }
}

/** Tempo, main volume and echo as they are in the main sections, so each pattern plays alone too. */
function cruise(p: Pat): void {
  p.fx(T.cond, 0, 0, fx('F', 132), fx('W', 0x5a));
  p.fx(T.cond, 1, 0, fx('E', 0x28), fx('B', 0x30));
}

// ------------------------------------------------------------------ patterns

/** Intro 1: wind rises out of silence, the strings swell in, the bell calls, the tempo picks up. */
function dawn(): Pattern {
  const p = new Pat('pat_dawn', 'Dämmerung');
  // Main volume fades in: W sets the start, H slides, H00 continues the slide by effect memory.
  p.fx(T.cond, 0, 0, fx('F', 100), fx('W', 0x10));
  p.fx(T.cond, 1, 0, fx('H', 0x10), fx('E', 0x30));
  p.fx(T.cond, 2, 0, fx('B', 0x50));
  for (let l = 3; l <= 12; l++) p.fx(T.cond, l, 0, fx('H', 0x00));
  p.fx(T.cond, 13, 0, fx('W', 0x5a));
  // Accelerando, one step per bar.
  p.fx(T.cond, 16, 0, fx('F', 108));
  p.fx(T.cond, 32, 0, fx('F', 116));
  p.fx(T.cond, 48, 0, fx('F', 124));

  // Wind: noise whose clock rises (N), panned across by pan slides (L, then L00).
  p.note(T.wind, 0, 0, n('C4'), 0x60, fx('N', 0x14));
  p.fx(T.wind, 16, 0, fx('N', 0x16), fx('L', 0x10));
  for (let l = 17; l < 24; l++) p.fx(T.wind, l, 0, fx('L', 0x00));
  p.fx(T.wind, 32, 0, fx('N', 0x18), fx('L', 0x01));
  for (let l = 33; l < 44; l++) p.fx(T.wind, l, 0, fx('L', 0x00));
  p.fx(T.wind, 48, 0, fx('N', 0x1a));
  p.note(T.wind, 58, 0, NOTE_OFF);

  // Strings: the first chord swells in on a GAIN linear increase (G C5) instead of its ADSR.
  p.chord(T.pad, 0, PROG[0], 0x60, fx('G', 0xc5));
  p.chord(T.pad, 32, PROG[1], 0x58);
  p.chord(T.pad, 48, PROG[2], 0x58);

  // FM bell calls; the modulator plays a tritone above (+6) for a metallic ring.
  for (const [l, name] of [
    [8, 'B5'],
    [20, 'G5'],
    [28, 'E5'],
    [40, 'F#5'],
    [52, 'D6'],
  ] as [number, string][]) {
    p.note(T.bellMod, l, 0, n(name) + 6, 0x7f);
    p.note(T.bell, l, 0, n(name), 0x70);
  }
  p.note(T.bellMod, 60, 0, NOTE_OFF);
  p.note(T.bell, 60, 0, NOTE_OFF);

  // The arp wakes up in the second half.
  p.chord(T.arp, 32, PROG[1].map((x) => x + 12), 0x50);
  p.chord(T.arp, 48, PROG[2].map((x) => x + 12), 0x60);
  return p.p;
}

/** Intro 2: the motor starts. Staccato bass (cut), hats from bar 2, snare roll into the loop. */
function motor(): Pattern {
  const p = new Pat('pat_motor', 'Motor');
  p.fx(T.cond, 0, 0, fx('F', 130), fx('B', 0x30));
  p.fx(T.cond, 32, 0, fx('F', 132));
  for (let bar = 0; bar < 4; bar++) {
    motorik(p, bar, bar >= 2);
    if (bar >= 1) hats(p, bar);
    // The first two bars are clipped short by the cut effect (C02: release after 2 ticks).
    if (bar < 2) bass(p, bar, fx('C', 0x02));
    else bass(p, bar);
  }
  snareRoll(p);
  p.chord(T.pad, 0, PROG[0], 0x50);
  p.chord(T.pad, 32, PROG[1], 0x50);
  p.chord(T.arp, 0, PROG[0].map((x) => x + 12), 0x68);
  p.chord(T.arp, 32, PROG[1].map((x) => x + 12), 0x68);
  return p.p;
}

/** A: the full groove, and the song's loop point. */
function autobahn(): Pattern {
  const p = new Pat('pat_autobahn', 'Autobahn');
  cruise(p);
  groove(p, 3);
  return p.p;
}

/** A': a legato lead on top: chord tones on the beats, one portamento leap (P, P00), vibrato that blooms on held notes, a short fall and a linear release. */
function fastLane(): Pattern {
  const p = new Pat('pat_lane', 'Überholspur');
  cruise(p);
  groove(p, 2);
  p.note(T.pad, 0, 2, NOTE_OFF);
  const L = T.lead;
  p.note(L, 0, 0, n('E5'), 0x70)
    .note(L, 4, 0, n('G5'))
    .note(L, 6, 0, n('F#5'))
    .note(L, 8, 0, n('E5'))
    .note(L, 12, 0, n('B4'))
    .note(L, 14, 0, n('D5'))
    .note(L, 16, 0, n('F#5'))
    .note(L, 24, 0, n('A5'))
    .note(L, 26, 0, n('G5'))
    .note(L, 28, 0, n('F#5'))
    .note(L, 30, 0, n('C5'))
    // The one deliberate glide: a fifth up from C5 to G5 (P20), continued by effect memory (P00).
    .note(L, 32, 0, n('G5'), undefined, fx('P', 0x20))
    .fx(L, 33, 0, fx('P', 0x00))
    .fx(L, 34, 0, fx('P', 0x00))
    .note(L, 40, 0, n('E5'))
    .note(L, 44, 0, n('C5'))
    .note(L, 46, 0, n('D5'))
    .note(L, 48, 0, n('F#5'))
    .note(L, 52, 0, n('A5'))
    .note(L, 56, 0, n('E5'))
    // A short fall as the last note is let go (D18), then the linear release.
    .fx(L, 61, 0, fx('D', 0x18))
    .note(L, 62, 0, NOTE_OFF);
  // The arp steps back under the lead: lower track volume in this pattern's header.
  p.p.tracks[T.arp].volume = 88;
  return p.p;
}

/** The exit before B: the groove once more; in the last bar the arp and one pad voice drop out. */
function exit(): Pattern {
  const p = new Pat('pat_exit', 'Ausfahrt');
  cruise(p);
  groove(p, 3);
  p.off(T.arp, 48, 3);
  p.note(T.pad, 48, 2, NOTE_OFF);
  // A small fill instead: the open hat on the last off-beat, then the snare doubles.
  p.note(T.drums, 62, 1, SNARE, 0x50);
  return p.p;
}

/** B: the same harmony moved up a fourth by track transpose; the FM bell sings; the strings tremble. */
function valley(): Pattern {
  const p = new Pat('pat_valley', 'Talfahrt');
  cruise(p);
  for (let bar = 0; bar < 4; bar++) {
    motorik(p, bar);
    hats(p, bar);
    bass(p, bar);
    p.chord(T.pad, bar * 16, PROG[bar].slice(1), 0x60, fx('T', 0x46));
  }
  // Tremolo on every line: T46 at each chord, T00 (memory) in between.
  for (let l = 0; l < LINES; l++) if (l % 16 !== 0) for (const c of [0, 1]) p.fx(T.pad, l, c, fx('T', 0x00));
  // Same notes as A, sounding in A dorian: bass and strings are transposed by their track headers.
  p.p.tracks[T.bass].transpose = 5;
  p.p.tracks[T.pad].transpose = 5;

  const melody: [number, string][] = [
    [0, 'E5'], [6, 'A5'], [8, 'G5'], [12, 'E5'],
    [16, 'D5'], [20, 'E5'], [24, 'C5'], [28, 'D5'],
    [32, 'C5'], [38, 'F#5'], [40, 'E5'], [44, 'C5'],
    [48, 'D5'], [52, 'B4'], [56, 'A4'],
  ];
  for (const [l, name] of melody) {
    p.note(T.bellMod, l, 0, n(name) + 6, 0x7f);
    p.note(T.bell, l, 0, n(name), 0x74);
  }
  p.note(T.bellMod, 62, 0, NOTE_OFF);
  p.note(T.bell, 62, 0, NOTE_OFF);
  return p.p;
}

/**
 * Breakdown: the drums stop, chords ring out on their long release, the echo swells and freezes
 * into a stutter, the arp wanders across and fades, and a noise riser leads back into the groove.
 */
function silence(): Pattern {
  const p = new Pat('pat_silence', 'Funkstille');
  p.note(T.bass, 0, 0, NOTE_OFF);
  // Echo: more feedback (B60), echo volume swell (Y10, then Y00), freeze (Z00) and release (Z01).
  p.fx(T.cond, 0, 0, fx('F', 132), fx('B', 0x48));
  p.fx(T.cond, 1, 0, fx('E', 0x28), fx('Y', 0x10));
  for (let l = 2; l <= 4; l++) p.fx(T.cond, l, 0, fx('Y', 0x00));
  p.fx(T.cond, 30, 0, fx('Z', 0x00));
  p.fx(T.cond, 40, 0, fx('Z', 0x01));
  p.fx(T.cond, 48, 0, fx('B', 0x30), fx('E', 0x28));

  // Strings: each chord is released early, so its long exponential tail rings into the gap.
  p.chord(T.pad, 0, PROG[0], 0x58).off(T.pad, 10, 3);
  p.chord(T.pad, 16, PROG[1], 0x58, fx('G', 0xc6)).off(T.pad, 28, 3);
  p.chord(T.pad, 32, PROG[2], 0x58).off(T.pad, 42, 3);

  // A falling bell phrase whose echo gets frozen.
  for (const [l, name] of [
    [0, 'E6'],
    [4, 'D6'],
    [8, 'B5'],
    [12, 'A5'],
    [16, 'G5'],
    [24, 'E5'],
  ] as [number, string][]) {
    p.note(T.bellMod, l, 0, n(name) + 6, 0x7f);
    p.note(T.bell, l, 0, n(name), 0x6c);
  }
  p.note(T.bellMod, 29, 0, NOTE_OFF);
  p.note(T.bell, 29, 0, NOTE_OFF);

  // Arp: track pan moves it left, right and back (X); then a track volume fade (K02, K00).
  for (let bar = 0; bar < 4; bar++) p.chord(T.arp, bar * 16, PROG[bar].map((x) => x + 12), 0x60);
  p.fx(T.arp, 0, 0, fx('X', 0x10));
  p.fx(T.arp, 16, 0, fx('X', 0x70));
  p.fx(T.arp, 32, 0, fx('X', 0x40));
  p.fx(T.arp, 40, 0, fx('K', 0x02));
  for (let l = 41; l < 48; l++) p.fx(T.arp, l, 0, fx('K', 0x00));

  // Riser: noise whose clock climbs every two lines while it gets louder (A20, then A00).
  p.note(T.wind, 48, 0, n('C4'), 0x18, fx('N', 0x10), fx('A', 0x20));
  for (let l = 49; l < 63; l++) {
    const step = l % 2 === 0 ? [fx('N', 0x10 + (l - 48))] : [];
    p.fx(T.wind, l, 0, ...step, fx('A', 0x00));
  }
  p.note(T.wind, 63, 0, NOTE_OFF);
  p.note(T.drums, 48, 0, KICK, 0x70);
  snareRoll(p);
  return p.p;
}

// ------------------------------------------------------------------ project

export function demoProject(): Project {
  const project = emptyProject();
  project.title = 'Autobahn 16 bit';
  project.author = 'Krautrecker demo';
  project.timing = { bpm: 132, linesPerBeat: 4, ticksPerLine: 6 };
  project.samples = samples();
  project.devices = devices();
  const patterns = [dawn(), motor(), autobahn(), fastLane(), exit(), valley(), silence()];
  // The noise hats sit a little back in the mix: track volume in each header.
  for (const pat of patterns) pat.tracks[T.hats].volume = 100;
  project.patterns = patterns;
  project.order = ['pat_dawn', 'pat_motor', 'pat_autobahn', 'pat_lane', 'pat_exit', 'pat_valley', 'pat_silence'];
  project.loopOrderIndex = 2;
  project.hardware.echo = { delay: 7, feedback: 0x30, volumeL: 0x28, volumeR: 0x28, fir: [96, 16, 8, 4, 2, 1, 0, 0], writeEnabled: true };
  project.hardware.mainVolumeL = 90;
  project.hardware.mainVolumeR = 90;
  project.seed = 0x4b52;
  return project;
}
