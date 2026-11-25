import type { BuiltSample } from '../brr/sampleBuild';
import { DSP_RATE } from '../dsp/tables';
import { chordsBySongLine, parseChord, patternKey, pitchClassName, scaleDegree, scalePitchClasses, keyName, type Chord } from '../model/harmony';
import { clamp, noteName } from '../model/notes';
import type { Device, Project, Sample, Zone } from '../model/types';
import { NOTE_CUT, NOTE_OFF } from '../model/types';
import type { LogicalNote, SongPattern } from './expand';
import { pitchFor, playLengthSamples, selectZone, zoneRoot } from './instrument';
import type { Diagnostic, SourceRef } from './ir';

/**
 * Checks that read the compiled song as a whole and point at sound problems the hardware rules
 * cannot see: aliasing (a hardware warning) and musical hints (detune, chord clashes, notes
 * outside the key, register crowding). Musical hints are always 'info': they flag what usually
 * sounds wrong, but a composer may want exactly that. Pure and deterministic like the compiler.
 */

/** The S-DSP outputs 32 kHz, so anything above 16 kHz folds back. */
const NYQUIST = DSP_RATE / 2;
/** Tuning differences above this many cents between simultaneous devices beat audibly. */
export const DETUNE_CENTS = 5;
/** Pitch-class intervals that clash with a chord tone: minor second / major seventh, tritone. */
const CLASH_INTERVALS = [1, 6, 11];
/** Notes this close (in semitones, unison included) sit in the same spot and mask each other. */
export const CROWDING_SEMITONES = 2;

export interface CheckInput {
  project: Project;
  song: SongPattern[];
  devices: Map<string, Device>;
  samples: Map<string, Sample>;
  built: Map<string, BuiltSample>;
  notes: LogicalNote[];
  tpl: number;
  samplesPerTick: number;
}

export function runChecks(input: CheckInput, out: Diagnostic[]): void {
  checkAliasing(input, out);
  checkDetune(input, out);
  const score = extractScore(input);
  checkHarmony(input, score, out);
  checkCrowding(input, score, out);
}

// ------------------------------------------------------------------ aliasing

/**
 * A key-on whose pitch lifts the sample's highest significant partial above 16 kHz. Reported once
 * per zone, at its worst note. Pitch-modulated notes are skipped: their pitch follows another
 * voice's output and cannot be predicted. Noise notes do not play their sample.
 */
function checkAliasing(input: CheckInput, out: Diagnostic[]): void {
  const worst = new Map<string, { ln: LogicalNote; pitch: number; source: SourceRef; tick: number; freq: number }>();
  for (const ln of input.notes) {
    if (ln.pitchModSource !== undefined || ln.noise !== undefined) continue;
    const built = input.built.get(ln.zone.sampleId);
    if (!built?.highestFrequency) continue;
    let pitch = ln.keyOn.pitch;
    let source = ln.keyOn.source;
    let tick = ln.keyOn.tick;
    for (const e of ln.events) {
      if (e.type === 'setPitch' && e.pitch > pitch) {
        pitch = e.pitch;
        source = e.source;
        tick = e.tick;
      }
    }
    const freq = (built.highestFrequency * pitch * DSP_RATE) / (0x1000 * built.effectiveRate);
    if (freq <= NYQUIST) continue;
    const device = input.devices.get(ln.deviceId);
    if (!device) continue;
    const key = `${ln.deviceId}:${device.zones.indexOf(ln.zone)}`;
    const prev = worst.get(key);
    if (!prev || freq > prev.freq) worst.set(key, { ln, pitch, source, tick, freq });
  }
  for (const w of worst.values()) {
    const device = input.devices.get(w.ln.deviceId)!;
    const sample = input.samples.get(w.ln.zone.sampleId);
    const built = input.built.get(w.ln.zone.sampleId)!;
    if (!sample) continue;
    const root = zoneRoot(w.ln.zone, input.samples);
    const tune = (sample.fineTune + device.fineTune) / 100;
    // Note at which a pitch register value plays: invert pitchFor.
    const noteAt = (p: number) => root - tune + 12 * Math.log2((p * DSP_RATE) / (0x1000 * built.effectiveRate));
    const worstNote = Math.round(noteAt(w.pitch));
    const fineUpTo = Math.floor(root - tune + 12 * Math.log2(NYQUIST / built.highestFrequency!) + 1e-9);
    const [lo, hi] = w.ln.zone.keyRange;
    const range = lo <= 0 && hi >= 127 ? 'all keys' : `${noteName(lo)}–${noteName(hi)}`;
    const clean =
      fineUpTo >= 0
        ? `This zone is clean up to ${noteName(fineUpTo)}. Band-limit the sample (fewer harmonics, or a low-pass filter), or add a zone with a duller sample for notes above ${noteName(fineUpTo)}.`
        : 'It aliases on every note. Band-limit the sample (fewer harmonics, or a low-pass filter).';
    out.push({
      kind: 'aliasing',
      severity: 'warning',
      category: 'hardware',
      message: `"${device.name}" plays sample "${sample.name}" (zone ${range}) at ${noteName(worstNote)}: its highest significant partial (${khz(built.highestFrequency!)} at the root) rises to ${khz(w.freq)}, above the S-DSP's 16 kHz limit, and folds back as an off-pitch partial. ${clean}`,
      source: w.source,
      tick: w.tick,
    });
  }
}

function khz(hz: number): string {
  return `${(hz / 1000).toFixed(1)} kHz`;
}

// ------------------------------------------------------------------ detune

interface Tuned {
  ln: LogicalNote;
  start: number;
  end: number;
  /** Deviation from equal temperament in cents. */
  cents: number;
  /** Of which the device's fine tune; the rest is the 14-bit register's rounding. */
  deviceCents: number;
}

/**
 * Notes of different devices that sound together while their tunings differ by more than
 * `DETUNE_CENTS`. A note's deviation is its pitch register against the exact equal-tempered value:
 * device fine tune plus the register's rounding. The sample's fine tune is a calibration (it says
 * how far the recording sits from its root note) and so is not a deviation. Drums, noise, fixed
 * pitches, pitch-modulated and silent notes are left out.
 */
function checkDetune(input: CheckInput, out: Diagnostic[]): void {
  const tuned: Tuned[] = [];
  for (const ln of input.notes) {
    const device = input.devices.get(ln.deviceId);
    const sample = input.samples.get(ln.zone.sampleId);
    const built = input.built.get(ln.zone.sampleId);
    if (!device || !sample || !built || !isPitched(device, ln.zone) || ln.noise !== undefined || ln.pitchModSource !== undefined) continue;
    if (ln.keyOn.clamped || (ln.keyOn.volL === 0 && ln.keyOn.volR === 0)) continue;
    const root = zoneRoot(ln.zone, input.samples);
    const ideal = 0x1000 * (built.effectiveRate / DSP_RATE) * Math.pow(2, (ln.keyOn.note - root + sample.fineTune / 100) / 12);
    const { pitch } = pitchFor(ln.keyOn.note, root, sample.fineTune + device.fineTune, built);
    const end = Math.min(ln.heldEnd, ln.naturalEnd);
    if (end <= ln.startTick) continue;
    tuned.push({ ln, start: ln.startTick, end, cents: 1200 * Math.log2(pitch / ideal), deviceCents: device.fineTune });
  }
  tuned.sort((a, b) => a.start - b.start || a.ln.id - b.ln.id);
  const order = new Map(input.project.devices.map((d, i) => [d.id, i]));
  const pairs = new Map<string, { a: Tuned; b: Tuned; diff: number; tick: number }>();
  const active: Tuned[] = [];
  for (const t of tuned) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i].end <= t.start) active.splice(i, 1);
    for (const o of active) {
      if (o.ln.deviceId === t.ln.deviceId) continue;
      const diff = Math.abs(o.cents - t.cents);
      if (diff <= DETUNE_CENTS) continue;
      const [a, b] = (order.get(o.ln.deviceId) ?? 0) <= (order.get(t.ln.deviceId) ?? 0) ? [o, t] : [t, o];
      const key = `${a.ln.deviceId}|${b.ln.deviceId}`;
      const prev = pairs.get(key);
      if (!prev || diff > prev.diff + 1e-9) pairs.set(key, { a, b, diff, tick: t.start });
    }
    active.push(t);
  }
  for (const p of pairs.values()) {
    const name = (t: Tuned) => input.devices.get(t.ln.deviceId)!.name;
    const describe = (t: Tuned) => `"${name(t)}" ${signed(t.cents)} (device fine tune ${signed(t.deviceCents)}, register rounding ${signed(t.cents - t.deviceCents)})`;
    out.push({
      kind: 'detune',
      severity: 'info',
      category: 'music',
      message: `"${name(p.a)}" and "${name(p.b)}" sound together ${p.diff.toFixed(1)} cents apart, enough to beat audibly. Deviation from equal temperament: ${describe(p.a)}; ${describe(p.b)}.`,
      source: (p.a.start >= p.b.start ? p.a : p.b).ln.keyOn.source,
      tick: p.tick,
    });
  }
}

function signed(cents: number): string {
  const r = Math.round(cents * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} cents`;
}

/** A zone that plays the note's own pitch: not a drum, not noise, not fixed. */
function isPitched(device: Device, zone: Zone): boolean {
  return device.mode !== 'drum' && zone.noise === undefined && zone.fixedPitch === undefined;
}

// ------------------------------------------------------------------ the score

/**
 * A melodic note as written: where it starts and how long it is held, in song lines. Harmony and
 * register are a matter of the written notes, not of hardware voices, so these checks read the
 * patterns directly. Release tails and envelope decay are ignored; a one-shot sample ends when it
 * runs out.
 */
interface ScoreNote {
  sp: SongPattern;
  /** Song line of the pattern's first line. */
  base: number;
  track: number;
  column: number;
  line: number;
  start: number;
  end: number;
  note: number;
  device: Device;
  /** The register the note occupies: an arpeggiator plays its held keys over several octaves. */
  octaves: number;
}

function extractScore(input: CheckInput): ScoreNote[] {
  const { song, devices } = input;
  const notes: ScoreNote[] = [];
  const trackCount = song.reduce((m, sp) => Math.max(m, sp.pattern.tracks.length), 0);
  const songLines = song.reduce((n, sp) => n + sp.pattern.lines, 0);
  for (let t = 0; t < trackCount; t++) {
    let deviceId: string | null | undefined;
    /** Open notes by column (poly, arp), or under -1 for mono and legato (one note per track). */
    const open = new Map<number, ScoreNote>();
    const close = (slot: number, at: number) => {
      const n = open.get(slot);
      if (n) n.end = Math.min(n.end, at);
      open.delete(slot);
    };
    let base = 0;
    for (const sp of song) {
      const track = sp.pattern.tracks[t];
      const id = track ? track.deviceId : undefined;
      if (id !== deviceId) {
        // A different device takes over this channel: what was playing ends, as in stage 2.
        for (const slot of [...open.keys()]) close(slot, base);
        deviceId = id;
      }
      const device = id ? devices.get(id) : undefined;
      if (track && device && device.mode !== 'drum') {
        const solo = device.mode === 'mono' || device.mode === 'legato';
        for (let line = 0; line < sp.pattern.lines; line++) {
          const row = track.cells[line];
          if (!row) continue;
          const at = base + line;
          for (let c = 0; c < track.noteColumns; c++) {
            const cell = row[c];
            if (!cell) continue;
            const slot = solo ? -1 : c;
            if (cell.note === NOTE_OFF || cell.note === NOTE_CUT) close(slot, at);
            else if (typeof cell.note === 'number') {
              close(slot, at);
              const note = clamp(cell.note + Math.round(track.transpose), 0, 127);
              const audible = (cell.volume ?? 127) * track.volume > 0;
              const noise = cell.fx?.some((e) => e?.type === 'noise' && e.value < 0x20) ?? false;
              const n = audible && !noise ? scoreNote(input, { sp, base, track: t, column: c, line, note, device }) : null;
              if (n) {
                open.set(slot, n);
                notes.push(n);
              }
            }
            if (cell.fx?.some((e) => e?.type === 'cut')) close(slot, at + 1);
          }
        }
      }
      base += sp.pattern.lines;
    }
    for (const slot of [...open.keys()]) close(slot, songLines);
  }
  return notes;
}

/** A score note for a written note, or null if it is not a melodic, audible note. */
function scoreNote(
  input: CheckInput,
  n: { sp: SongPattern; base: number; track: number; column: number; line: number; note: number; device: Device },
): ScoreNote | null {
  const { samples, built } = input;
  const zone = selectZone(n.device, n.note, samples)?.zone;
  if (!zone || !isPitched(n.device, zone) || n.device.volume * zone.volume === 0) return null;
  const sample = samples.get(zone.sampleId);
  const b = built.get(zone.sampleId);
  if (!sample || !b) return null;
  const start = n.base + n.line;
  let end = Infinity;
  if (b.loopBlock < 0) {
    const { pitch } = pitchFor(n.note, zoneRoot(zone, samples), sample.fineTune + n.device.fineTune, b);
    const ticks = playLengthSamples(b, pitch) / input.samplesPerTick;
    end = start + Math.max(1, Math.ceil(ticks / input.tpl));
  }
  const octaves = n.device.mode === 'arp' ? clamp(Math.round(n.device.arp.octaves), 1, 4) : 1;
  return { ...n, start, end, octaves };
}

function sourceOf(n: ScoreNote): SourceRef {
  return { orderIndex: n.sp.orderIndex, patternId: n.sp.pattern.id, track: n.track, line: n.line, column: n.column };
}

function tickOf(input: CheckInput, n: ScoreNote): number {
  return n.sp.startTick + n.line * input.tpl;
}

// ------------------------------------------------------------------ harmony

/**
 * Notes that start on a strong beat (the first line of a beat) and either clash with the chord
 * marker in force (a semitone or a tritone against a chord tone) or lie outside the key without
 * being a chord tone. A slash chord's bass counts as a chord tone: "D/E" states an E pedal, so an E
 * on top is consonant and an F rubs against it. A held pedal that the chord symbol does not state
 * is flagged where it is struck again. One hint per pattern, track and line.
 */
function checkHarmony(input: CheckInput, score: ScoreNote[], out: Diagnostic[]): void {
  const { project, song } = input;
  const lpb = Math.max(1, Math.round(project.timing.linesPerBeat));
  const chords = chordsBySongLine({ ...project, order: song.map((sp) => sp.pattern.id) });
  const parsed = new Map<string, Chord | null>();
  const parse = (symbol: string) => {
    if (!parsed.has(symbol)) parsed.set(symbol, parseChord(symbol));
    return parsed.get(symbol)!;
  };
  // Findings per occurrence of a line (order index, track, line), in song order.
  const groups = new Map<string, { first: ScoreNote; clash: string[]; outside: string[] }>();
  for (const n of score) {
    if (n.line % lpb !== 0) continue;
    const key = patternKey(project, n.sp.pattern);
    const marker = chords[n.start] ?? null;
    const chord = marker ? parse(marker.symbol) : null;
    if (!key && !chord) continue;
    const pc = n.note % 12;
    if (chord?.tones.has(pc)) continue;
    const against = chord ? [...chord.tones].filter((t) => CLASH_INTERVALS.includes((pc - t + 12) % 12)) : [];
    const outside = key !== null && !scalePitchClasses(key).has(pc);
    if (against.length === 0 && !outside) continue;
    const id = `${n.sp.orderIndex}:${n.track}:${n.line}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { first: n, clash: [], outside: [] }));
    const degree = key ? ` (${scaleDegree(n.note, key)} in ${keyName(key)})` : '';
    if (against.length > 0) {
      const how = against.map((t) => {
        const iv = (pc - t + 12) % 12;
        return iv === 6 ? `a tritone from ${pitchClassName(t)}` : `a semitone ${iv === 1 ? 'above' : 'below'} ${pitchClassName(t)}`;
      });
      g.clash.push(`${noteName(n.note)} is ${how.join(' and ')} in ${chord!.symbol}${outside ? `, and outside the key${degree}` : ''}`);
    } else {
      g.outside.push(`${noteName(n.note)}${degree}`);
    }
  }
  const reported = new Set<string>();
  for (const g of groups.values()) {
    const n = g.first;
    const once = `${n.sp.pattern.id}:${n.track}:${n.line}`;
    if (reported.has(once)) continue;
    reported.add(once);
    const who = `"${n.device.name}" on a strong beat`;
    const marker = chords[n.start] ?? null;
    let message: string;
    if (g.clash.length > 0) {
      const parts = [...g.clash, ...g.outside.map((o) => `${o} is outside the key`)];
      message = `${who}: ${parts.join('; ')}. A hint: a suspension or passing note may be intended.`;
    } else {
      const reason = marker ? `not a tone of the chord ${marker.symbol}` : 'no chord marker explains it';
      message = `${who}: ${g.outside.join(', ')} ${g.outside.length > 1 ? 'are' : 'is'} outside the key, and ${reason}.`;
    }
    out.push({
      kind: g.clash.length > 0 ? 'chordClash' : 'outsideKey',
      severity: 'info',
      category: 'music',
      message,
      source: sourceOf(n),
      tick: tickOf(input, n),
    });
  }
}

// ------------------------------------------------------------------ register crowding

interface Crowding {
  a: ScoreNote;
  b: ScoreNote;
  pa: number;
  pb: number;
}

/**
 * Two melodic tracks of different devices that hold notes within `CROWDING_SEMITONES` of each
 * other (unison included) for at least a beat without a break. Instruments that close share the
 * same frequencies and mask each other. One hint per track pair and pattern, at the first such
 * stretch.
 */
function checkCrowding(input: CheckInput, score: ScoreNote[], out: Diagnostic[]): void {
  const lpb = Math.max(1, Math.round(input.project.timing.linesPerBeat));
  const reported = new Set<string>();
  let base = 0;
  for (const sp of input.song) {
    const lines = sp.pattern.lines;
    const byTrack = new Map<number, ScoreNote[]>();
    for (const n of score) {
      if (n.start >= base + lines || n.end <= base || n.end <= n.start) continue;
      const list = byTrack.get(n.track);
      if (list) list.push(n);
      else byTrack.set(n.track, [n]);
    }
    const tracks = [...byTrack.keys()].sort((a, b) => a - b);
    for (let i = 0; i < tracks.length; i++) {
      for (let j = i + 1; j < tracks.length; j++) {
        const key = `${sp.pattern.id}:${tracks[i]}:${tracks[j]}`;
        if (reported.has(key)) continue;
        const found = crowdedStretch(byTrack.get(tracks[i])!, byTrack.get(tracks[j])!, base, lines, lpb);
        if (!found) continue;
        reported.add(key);
        const { a, b, pa, pb, line, length } = found;
        const later = b.start >= a.start ? b : a;
        const beats = length / lpb;
        out.push({
          kind: 'registerCrowding',
          severity: 'info',
          category: 'music',
          message: `"${a.device.name}" (track ${a.track + 1}) and "${b.device.name}" (track ${b.track + 1}) stay within a whole tone of each other for ${length} lines (${beats === 1 ? '1 beat' : `${Number.isInteger(beats) ? beats : beats.toFixed(1)} beats`}), starting with ${noteName(pa)} against ${noteName(pb)}. Instruments this close mask each other; move one by an octave or thin the voicing.`,
          source: { orderIndex: sp.orderIndex, patternId: sp.pattern.id, track: later.track, line, column: later.column },
          tick: sp.startTick + line * input.tpl,
        });
      }
    }
    base += lines;
  }
}

/** The first run of at least `minLines` lines in a pattern in which the two tracks crowd each other. */
function crowdedStretch(as: ScoreNote[], bs: ScoreNote[], base: number, lines: number, minLines: number): (Crowding & { line: number; length: number }) | null {
  let run: (Crowding & { line: number; length: number }) | null = null;
  for (let line = 0; line <= lines; line++) {
    const hit = line < lines ? crowdedAt(as, bs, base + line) : null;
    if (hit) {
      if (run) run.length++;
      else run = { ...hit, line, length: 1 };
    } else {
      if (run && run.length >= minLines) return run;
      run = null;
    }
  }
  return null;
}

function crowdedAt(as: ScoreNote[], bs: ScoreNote[], at: number): Crowding | null {
  for (const a of as) {
    if (a.start > at || a.end <= at) continue;
    for (const b of bs) {
      if (b.start > at || b.end <= at || a.device.id === b.device.id) continue;
      for (let oa = 0; oa < a.octaves; oa++) {
        for (let ob = 0; ob < b.octaves; ob++) {
          const pa = a.note + 12 * oa;
          const pb = b.note + 12 * ob;
          if (Math.abs(pa - pb) <= CROWDING_SEMITONES) return { a, b, pa, pb };
        }
      }
    }
  }
  return null;
}

