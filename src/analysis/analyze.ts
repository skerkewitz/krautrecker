import type { DiagnosticKind, SourceRef } from '../compiler/ir';
import { keyName, patternKey } from '../model/harmony';
import type { Project } from '../model/types';
import { BANDS, bandShares, levels, measurePitches, tuningStats, type Levels, type TuningStats } from './measure';
import type { ClipCounts, Rendered, SongRender } from './render';

/**
 * The song analysis: levels, spectral balance and masking per section and track, tuning per
 * track, voice usage, diagnostics, harmony and comments, as one JSON-friendly object. Built from a
 * SongRender, so it measures exactly what the player outputs.
 */

/** A track below this share of a section's energy is too quiet to mask anything. */
export const MASKING_MIN_SHARE = 0.05;
/** A track "puts most of its energy" into a band when the band holds at least this share. */
export const MASKING_MIN_BAND = 0.5;

export interface Position {
  orderIndex: number;
  patternId: string;
  patternName: string;
  line: number;
  track: number;
  column: number;
  /** Time of that line in the rendered song. */
  seconds: number;
}

export interface SignalStats extends Levels {
  /** Energy share per band of BANDS (fractions summing to 1). */
  bands: number[];
  /**
   * Sample frames clamped to 16 bits inside the DSP: in the voice mix (before main volume, so the
   * output level does not show it), the echo input, and the output. For a stem: the track alone.
   */
  clips: ClipCounts;
}

export interface TrackSignal extends SignalStats {
  track: number;
  /** This stem's energy as a fraction of all stems' energy in the same range. */
  share: number;
}

export interface TrackInfo {
  track: number;
  /** Names of the devices this track plays across the song, e.g. "Lead". */
  label: string;
  /** False when the track plays no note (e.g. a conductor track with only song effects). */
  sounding: boolean;
  tuning: TuningStats;
  /** Fine tune of the track's devices in cents (an intentional detune shows up in `tuning`). */
  deviceFineTune: { device: string; cents: number }[];
}

export interface Masking {
  band: string;
  tracks: number[];
}

export interface SectionAnalysis {
  orderIndex: number;
  patternId: string;
  patternName: string;
  /** False for the intro (before the loop point). */
  inLoop: boolean;
  lines: number;
  startSample: number;
  endSample: number;
  startSeconds: number;
  seconds: number;
  key: string | null;
  chords: { line: number; symbol: string }[];
  mix: SignalStats;
  tracks: TrackSignal[];
  masking: Masking[];
  voices: { maxUsed: number; maxDemand: number; linesOverLimit: number };
  /**
   * Largest |mix - sum of stems| in int16 steps (null without stems). The stems add up to the mix
   * except where the mix clamps (see clips) and for rounding in the echo filter.
   */
  stemResidual: number | null;
}

export interface DiagnosticGroup {
  kind: DiagnosticKind;
  severity: 'info' | 'warning' | 'error';
  count: number;
  items: { severity: 'info' | 'warning' | 'error'; message: string; position: Position | null; voice?: number }[];
}

export interface CommentInfo {
  patternId: string;
  patternName: string;
  line: number;
  track: number | null;
  trackLabel: string | null;
  text: string;
  /** Order entries that play this pattern, with the comment's time in each. */
  plays: { orderIndex: number; seconds: number }[];
}

export interface Analysis {
  title: string;
  author: string;
  timing: { bpm: number; linesPerBeat: number; ticksPerLine: number };
  key: string | null;
  loopOrderIndex: number;
  render: { sampleRate: number; songSamples: number; totalSamples: number; songSeconds: number; tailSeconds: number };
  bands: { name: string; fromHz: number }[];
  tracks: TrackInfo[];
  whole: { mix: SignalStats; tracks: TrackSignal[]; stemResidual: number | null };
  sections: SectionAnalysis[];
  voices: { usable: number; reserved: number; maxUsed: number; maxDemand: number; linesOverLimit: number; stolen: number; dropped: number };
  diagnostics: DiagnosticGroup[];
  comments: CommentInfo[];
}

/** Clamp counts of the render segments inside [start, end). */
function clipsIn(r: Rendered, segments: number[], start: number, end: number): ClipCounts {
  const sum: ClipCounts = { voice: 0, echo: 0, output: 0 };
  r.clips.forEach((c, i) => {
    if (segments[i] < start || segments[i + 1] > end) return;
    sum.voice += c.voice;
    sum.echo += c.echo;
    sum.output += c.output;
  });
  return sum;
}

function signal(r: Rendered, segments: number[], start: number, end: number): SignalStats {
  return { ...levels(r.audio, start, end), bands: bandShares(r.audio, start, end), clips: clipsIn(r, segments, start, end) };
}

function trackSignals(render: SongRender, start: number, end: number): TrackSignal[] {
  const stats = render.stems.map((s) => ({ track: s.track, ...signal(s, render.segments, start, end) }));
  const total = stats.reduce((a, s) => a + s.energy, 0);
  return stats.map((s) => ({ ...s, share: total > 0 ? s.energy / total : 0 }));
}

function stemResidual(render: SongRender, start: number, end: number): number | null {
  if (render.stems.length === 0) return null;
  let max = 0;
  for (const ch of ['left', 'right'] as const) {
    const mix = render.mix.audio[ch];
    for (let i = start; i < end; i++) {
      let sum = 0;
      for (const s of render.stems) sum += s.audio[ch][i];
      const d = Math.abs(mix[i] - sum);
      if (d > max) max = d;
    }
  }
  return Math.round(max * 32768);
}

function masking(tracks: TrackSignal[]): Masking[] {
  const out: Masking[] = [];
  BANDS.forEach((band, b) => {
    const ids = tracks.filter((t) => t.share >= MASKING_MIN_SHARE && t.bands[b] >= MASKING_MIN_BAND).map((t) => t.track);
    if (ids.length >= 2) out.push({ band: band.name, tracks: ids });
  });
  return out;
}

export function analyzeSong(project: Project, render: SongRender): Analysis {
  const { ir, tickStarts, sampleRate } = render;
  const tpl = ir.timing.ticksPerLine;
  const patterns = new Map(project.patterns.map((p) => [p.id, p]));
  const devices = new Map(project.devices.map((d) => [d.id, d]));
  const seconds = (sample: number) => sample / sampleRate;
  const tickSeconds = (tick: number) => seconds(tickStarts[Math.max(0, Math.min(tick, tickStarts.length - 1))]);

  // Sections: one per order entry that exists (the compiler skips missing patterns).
  const entries: { orderIndex: number; patternId: string; firstLine: number; lines: number }[] = [];
  ir.lines.forEach((l, i) => {
    const last = entries[entries.length - 1];
    if (last && last.orderIndex === l.orderIndex) last.lines++;
    else entries.push({ orderIndex: l.orderIndex, patternId: l.patternId, firstLine: i, lines: 1 });
  });

  // Tracks across the song, labelled by the devices they play.
  const trackCount = entries.reduce((m, e) => Math.max(m, patterns.get(e.patternId)?.tracks.length ?? 0), 0);
  const deviceIdsOf = (t: number) => [...new Set(entries.map((e) => patterns.get(e.patternId)?.tracks[t]?.deviceId).filter((d): d is string => !!d))];
  const labels = Array.from({ length: trackCount }, (_, t) => deviceIdsOf(t).map((id) => devices.get(id)?.name ?? id).join(' / ') || '(no device)');
  const pitches = measurePitches(project, ir, render.built);
  const sounding = new Set(render.stems.map((s) => s.track));
  for (const lane of ir.voices) for (const ev of lane) if (ev.type === 'keyOn') sounding.add(ev.source.track);
  const tracks: TrackInfo[] = labels.map((label, track) => ({
    track,
    label,
    sounding: sounding.has(track),
    tuning: tuningStats(pitches.filter((p) => p.track === track)),
    deviceFineTune: deviceIdsOf(track)
      .map((id) => devices.get(id))
      .filter((d) => d && d.fineTune !== 0)
      .map((d) => ({ device: d!.name, cents: d!.fineTune })),
  }));

  const usable = 8 - ir.reservedVoices.length;
  const sections: SectionAnalysis[] = entries.map((e) => {
    const pattern = patterns.get(e.patternId)!;
    const startTick = ir.lines[e.firstLine].tick;
    const startSample = tickStarts[startTick];
    const endSample = tickStarts[Math.min(startTick + e.lines * tpl, ir.totalTicks)];
    const trackStats = trackSignals(render, startSample, endSample);
    const usage = ir.voiceUsage.slice(e.firstLine, e.firstLine + e.lines);
    const key = patternKey(project, pattern);
    return {
      orderIndex: e.orderIndex,
      patternId: e.patternId,
      patternName: pattern.name,
      inLoop: e.orderIndex >= project.loopOrderIndex,
      lines: e.lines,
      startSample,
      endSample,
      startSeconds: seconds(startSample),
      seconds: seconds(endSample - startSample),
      key: key ? keyName(key) : null,
      chords: pattern.chords.map((c) => ({ line: c.line, symbol: c.symbol })),
      mix: signal(render.mix, render.segments, startSample, endSample),
      tracks: trackStats,
      masking: masking(trackStats),
      voices: {
        maxUsed: usage.reduce((m, u) => Math.max(m, u.used), 0),
        maxDemand: usage.reduce((m, u) => Math.max(m, u.demand), 0),
        linesOverLimit: usage.filter((u) => u.demand > usable).length,
      },
      stemResidual: stemResidual(render, startSample, endSample),
    };
  });

  const position = (src: SourceRef | undefined, tick: number | undefined): Position | null => {
    if (!src) return null;
    const t = tick ?? ir.lines.find((l) => l.orderIndex === src.orderIndex && l.line === src.line)?.tick ?? 0;
    return { ...src, patternName: patterns.get(src.patternId)?.name ?? src.patternId, seconds: tickSeconds(t) };
  };
  const groups = new Map<DiagnosticKind, DiagnosticGroup>();
  const rank = { info: 0, warning: 1, error: 2 } as const;
  for (const d of ir.diagnostics) {
    let g = groups.get(d.kind);
    if (!g) groups.set(d.kind, (g = { kind: d.kind, severity: d.severity, count: 0, items: [] }));
    g.count++;
    if (rank[d.severity] > rank[g.severity]) g.severity = d.severity;
    g.items.push({ severity: d.severity, message: d.message, position: position(d.source, d.tick), ...(d.voice !== undefined ? { voice: d.voice } : {}) });
  }
  const diagnostics = [...groups.values()].sort((a, b) => rank[b.severity] - rank[a.severity] || b.count - a.count);

  const comments: CommentInfo[] = [];
  for (const pattern of project.patterns) {
    for (const c of [...pattern.comments].sort((a, b) => a.line - b.line || (a.track ?? -1) - (b.track ?? -1))) {
      comments.push({
        patternId: pattern.id,
        patternName: pattern.name,
        line: c.line,
        track: c.track,
        trackLabel: c.track === null ? null : (labels[c.track] ?? null),
        text: c.text,
        plays: entries
          .filter((e) => e.patternId === pattern.id && c.line < e.lines)
          .map((e) => ({ orderIndex: e.orderIndex, seconds: tickSeconds(ir.lines[e.firstLine + c.line].tick) })),
      });
    }
  }

  const all = ir.voiceUsage;
  const end = render.totalSamples;
  return {
    title: project.title,
    author: project.author,
    timing: { ...project.timing },
    key: project.key ? keyName(project.key) : null,
    loopOrderIndex: project.loopOrderIndex,
    render: {
      sampleRate,
      songSamples: render.songSamples,
      totalSamples: render.totalSamples,
      songSeconds: seconds(render.songSamples),
      tailSeconds: seconds(render.totalSamples - render.songSamples),
    },
    bands: BANDS.map((b) => ({ name: b.name, fromHz: b.from })),
    tracks,
    whole: { mix: signal(render.mix, render.segments, 0, end), tracks: trackSignals(render, 0, end), stemResidual: stemResidual(render, 0, end) },
    sections,
    voices: {
      usable,
      reserved: ir.reservedVoices.length,
      maxUsed: all.reduce((m, u) => Math.max(m, u.used), 0),
      maxDemand: all.reduce((m, u) => Math.max(m, u.demand), 0),
      linesOverLimit: all.filter((u) => u.demand > usable).length,
      stolen: ir.diagnostics.filter((d) => d.kind === 'voiceStolen').length,
      dropped: ir.diagnostics.filter((d) => d.kind === 'noteDropped').length,
    },
    diagnostics,
    comments,
  };
}
