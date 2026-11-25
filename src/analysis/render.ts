import { buildSample, type BuiltSample } from '../brr/sampleBuild';
import { compileSong } from '../compiler/compile';
import type { IR, VoiceEvent } from '../compiler/ir';
import { SDsp } from '../dsp/sdsp';
import { Sequencer } from '../dsp/sequencer';
import { DSP_RATE } from '../dsp/tables';
import type { Project } from '../model/types';

/**
 * Offline rendering for the analysis: the song through the one playback path (compileSong ->
 * Sequencer -> SDsp), once from the start to the end of the order list, which plays the intro once
 * and the loop once. Pure: no file or DOM access.
 */

export interface Stereo {
  left: Float32Array;
  right: Float32Array;
}

/** Sample frames clamped to 16 bits (see SDsp.clips). */
export interface ClipCounts {
  voice: number;
  echo: number;
  output: number;
}

export interface Rendered {
  audio: Stereo;
  /** Clamp counts per segment of SongRender.segments. */
  clips: ClipCounts[];
}

export interface Stem extends Rendered {
  /** Track index, counted across patterns (track 0 of every pattern is stem 0). */
  track: number;
}

export interface SongRender {
  ir: IR;
  built: BuiltSample[];
  sampleRate: number;
  /** Sample position where each tick starts; `tickStarts[ir.totalTicks]` is the song's end. */
  tickStarts: number[];
  /** Samples until the end of the order list. */
  songSamples: number;
  /** All samples, including the tail after the end (releases and echo dying away). */
  totalSamples: number;
  /**
   * Segment boundaries in samples, from 0 to totalSamples: the start of every order entry, the
   * song's end and the end of the tail. Clamp counts are kept per segment.
   */
  segments: number[];
  mix: Rendered;
  /** One stem per track that plays at least one note, in track order. */
  stems: Stem[];
}

export interface RenderOptions {
  /** Seconds rendered after the song's end. Default 1. */
  tailSeconds?: number;
  /** Render the per-track stems as well. Default true. */
  stems?: boolean;
}

/**
 * The sample position of every tick, following tempo changes exactly as the Sequencer does
 * (same arithmetic in the same order), so section boundaries land on the right samples.
 */
export function tickStartSamples(ir: IR): number[] {
  const sptAt = (bpm: number) => (DSP_RATE * 60) / (bpm * ir.timing.linesPerBeat * ir.timing.ticksPerLine);
  const tempo = new Map<number, number>();
  for (const g of ir.global) if (g.type === 'tempo') tempo.set(g.tick, g.bpm);
  const starts = [0];
  let spt = sptAt(ir.timing.bpm);
  let frac = 0;
  let pos = 0;
  for (let t = 0; t < ir.totalTicks; t++) {
    const bpm = tempo.get(t);
    if (bpm !== undefined) spt = sptAt(bpm);
    frac += spt;
    const n = Math.floor(frac);
    frac -= n;
    pos += n;
    starts.push(pos);
  }
  return starts;
}

/**
 * Plays an IR once from tick 0 and renders up to the last boundary, counting clamps per segment
 * between consecutive boundaries (which must start at 0 and ascend).
 */
export function renderIR(ir: IR, built: BuiltSample[], boundaries: number[]): Rendered {
  const dsp = new SDsp();
  dsp.setSamples(built.map((b) => ({ brr: b.brr, loopBlock: b.loopBlock })));
  const seq = new Sequencer(dsp);
  seq.load(ir);
  seq.play(0, null, false);
  const samples = boundaries[boundaries.length - 1] ?? 0;
  const left = new Float32Array(samples);
  const right = new Float32Array(samples);
  const clips: ClipCounts[] = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const before = { ...dsp.clips };
    seq.render(left, right, boundaries[i], boundaries[i + 1] - boundaries[i]);
    clips.push({ voice: dsp.clips.voice - before.voice, echo: dsp.clips.echo - before.echo, output: dsp.clips.output - before.output });
  }
  return { audio: { left, right }, clips };
}

function muted(ev: VoiceEvent): VoiceEvent {
  if (ev.type === 'keyOn' || ev.type === 'setVolume') return { ...ev, volL: 0, volR: 0 };
  return ev;
}

/**
 * The IR for one track's stem: every event stays, but the voice volume of other tracks' notes is
 * zero. Removing their events instead would change what the stem's voices do: a stolen note would
 * keep sounding (a steal is a key-on without a key-off), and a pitch-modulated voice would lose its
 * modulator, because modulation reads the neighbour voice's output before its volume. Muting keeps
 * every voice, envelope and the noise generator exactly as in the mix, so the stems add up to the
 * mix apart from rounding and clipping.
 */
export function stemIR(ir: IR, track: number): IR {
  return { ...ir, voices: ir.voices.map((lane) => lane.map((ev) => (ev.source.track === track ? ev : muted(ev)))) };
}

/** Tracks that produce at least one key-on, in index order. */
export function soundingTracks(ir: IR): number[] {
  const set = new Set<number>();
  for (const lane of ir.voices) for (const ev of lane) if (ev.type === 'keyOn') set.add(ev.source.track);
  return [...set].sort((a, b) => a - b);
}

export function renderSong(project: Project, options: RenderOptions = {}): SongRender {
  const ir = compileSong(project);
  const built = project.samples.map((s) => buildSample(s));
  const tickStarts = tickStartSamples(ir);
  const songSamples = tickStarts[tickStarts.length - 1];
  const tail = Math.max(0, Math.round((options.tailSeconds ?? 1) * DSP_RATE));
  const totalSamples = songSamples + tail;
  const starts = ir.lines.filter((l, i) => i === 0 || l.orderIndex !== ir.lines[i - 1].orderIndex).map((l) => tickStarts[l.tick]);
  const segments = [...new Set([0, ...starts, songSamples, totalSamples])].sort((a, b) => a - b);
  const mix = renderIR(ir, built, segments);
  const stems = options.stems === false ? [] : soundingTracks(ir).map((track) => ({ track, ...renderIR(stemIR(ir, track), built, segments) }));
  return { ir, built, sampleRate: DSP_RATE, tickStarts, songSamples, totalSamples, segments, mix, stems };
}
