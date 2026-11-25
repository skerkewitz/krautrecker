import { hex } from '../model/notes';
import type { Analysis, Position, SignalStats, TrackInfo, TrackSignal } from './analyze';
import { FLOOR_DB } from './measure';

/** The analysis as compact plain text for the terminal: an overview, then one block per section. */

/** Tracks quieter than this in a section are listed as silent rather than given a table row. */
const SILENT_DB = -80;
/** Tuning deviations above this many cents get flagged. */
const TUNING_FLAG_CENTS = 3;
/** Diagnostic messages shown per kind before "... and N more". */
const ITEMS_PER_KIND = 4;

export function time(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function db(v: number): string {
  return v <= FLOOR_DB ? '-inf' : v.toFixed(1);
}

function pct(f: number): string {
  return `${Math.round(f * 100)}%`;
}

function signed(v: number, digits = 1): string {
  return (v >= 0 ? '+' : '') + v.toFixed(digits);
}

function trackName(a: Analysis, track: number, width = 0): string {
  const name = `T${track + 1} ${a.tracks[track]?.label ?? '?'}`;
  return width ? name.slice(0, width).padEnd(width) : name;
}

export function where(p: Position | null, a?: Analysis): string {
  if (!p) return 'song';
  const track = a ? trackName(a, p.track) : `T${p.track + 1}`;
  return `${p.patternName} ${hex(p.line, 2)} ${track}${p.column > 0 ? ` col ${p.column + 1}` : ''} @${time(p.seconds)}`;
}

const NAME_W = 18;
const BAND_W = 9;

function tableHead(a: Analysis): string {
  const bands = a.bands.map((b) => b.name.padStart(BAND_W)).join('');
  return `  ${'Track'.padEnd(NAME_W)}    RMS   Peak   Clip  Share${bands}`;
}

function signalCols(s: SignalStats): string {
  return `${db(s.rmsDb).padStart(7)}${db(s.peakDb).padStart(7)}${String(s.clips.voice + s.clips.output).padStart(7)}`;
}

function clipText(s: SignalStats): string {
  const c = s.clips;
  if (c.voice + c.echo + c.output === 0) return 'no clipping';
  const parts = [c.voice ? `voice mix ${c.voice}` : '', c.echo ? `echo input ${c.echo}` : '', c.output ? `output ${c.output}` : ''];
  return `CLIPPING in ${parts.filter(Boolean).join(', ')} frames`;
}

function bandCols(s: SignalStats): string {
  return s.bands.map((b) => pct(b).padStart(BAND_W)).join('');
}

function trackRows(a: Analysis, rows: TrackSignal[]): string[] {
  const out: string[] = [];
  const silent: string[] = [];
  for (const t of rows) {
    if (t.rmsDb < SILENT_DB) {
      silent.push(`T${t.track + 1}`);
      continue;
    }
    out.push(`  ${trackName(a, t.track, NAME_W)}${signalCols(t)}${pct(t.share).padStart(7)}${bandCols(t)}`);
  }
  if (silent.length) out.push(`  silent: ${silent.join(' ')}`);
  return out;
}

function tuningLine(a: Analysis, t: TrackInfo): string {
  const s = t.tuning;
  const name = trackName(a, t.track, NAME_W);
  if (s.notes === 0) return `  ${name} no pitched notes (noise or no notes)`;
  const legato = s.legato ? ` (${s.legato} legato)` : '';
  const flag = Math.max(Math.abs(s.minCents), Math.abs(s.maxCents)) > TUNING_FLAG_CENTS ? '  <-- off' : '';
  const w = s.worst;
  const worst = w ? `, worst ${signed(w.cents)} at ${patternName(a, w.source.patternId)} ${hex(w.source.line, 2)}` : '';
  const fine = t.deviceFineTune.length ? `; device fine tune ${t.deviceFineTune.map((d) => `${d.device} ${signed(d.cents, 0)}`).join(', ')}` : '';
  return `  ${name} ${String(s.notes).padStart(4)} notes${legato}: mean ${signed(s.meanCents)}, range ${signed(s.minCents)}..${signed(s.maxCents)}${worst}${fine}${flag}`;
}

function patternName(a: Analysis, id: string): string {
  return a.sections.find((s) => s.patternId === id)?.patternName ?? id;
}

export function formatAnalysis(a: Analysis): string {
  const out: string[] = [];
  const loop = a.sections.find((s) => s.orderIndex === a.loopOrderIndex);
  out.push(`${a.title || '(untitled)'}${a.author ? ` - ${a.author}` : ''}`);
  out.push(
    `Key ${a.key ?? 'not set'}. ${a.timing.bpm} BPM, ${a.timing.linesPerBeat} lines/beat, ${a.timing.ticksPerLine} ticks/line. ` +
      `${a.sections.length} order entries, loop from ${loop ? `${loop.orderIndex} "${loop.patternName}"` : a.loopOrderIndex}.`,
  );
  out.push(
    `Rendered intro + one loop pass: ${time(a.render.songSeconds)} (${a.render.songSamples} samples at ${a.render.sampleRate} Hz), plus ${a.render.tailSeconds.toFixed(1)} s tail.`,
  );
  out.push('');
  const m = a.whole.mix;
  out.push(`Mix: RMS ${db(m.rmsDb)} dBFS, peak ${db(m.peakDb)} dBFS, ${clipText(m)}.`);
  if (m.clips.voice) {
    out.push('  The S-DSP clamps the voice mix to 16 bits before main volume, so the output peak hides it.');
    out.push('  Lower device, note or track volumes; lowering main volume does not help.');
  }
  out.push(`Bands: ${a.bands.map((b, i) => `${b.name} ${pct(m.bands[i])}`).join(', ')} (from ${a.bands.map((b) => b.fromHz).join('/')} Hz).`);
  if (a.whole.stemResidual !== null) out.push(`Stems add up to the mix within ${a.whole.stemResidual} int16 steps (differences come from clipping and echo rounding).`);
  const v = a.voices;
  out.push(
    `Voices: ${v.usable} usable${v.reserved ? ` (${v.reserved} reserved for SFX)` : ''}; max used ${v.maxUsed}, max demand ${v.maxDemand}; ` +
      `${v.linesOverLimit} lines over the limit, ${v.stolen} steals, ${v.dropped} dropped notes.`,
  );
  out.push('');
  out.push("Tracks, whole song (dBFS; clip = frames the track alone clamps the voice mix or output; share = of all stems' energy):");
  out.push(tableHead(a));
  out.push(...trackRows(a, a.whole.tracks));
  const quiet = a.tracks.filter((t) => !t.sounding).map((t) => trackName(a, t.track));
  if (quiet.length) out.push(`  no notes: ${quiet.join(', ')}`);
  out.push('');
  out.push(`Tuning, cents from equal temperament (pitch register vs. the zone's sample tuning; noise voices skipped):`);
  for (const t of a.tracks) if (t.sounding) out.push(tuningLine(a, t));

  for (const s of a.sections) {
    out.push('');
    out.push(
      `[${s.orderIndex}] "${s.patternName}" ${s.inLoop ? 'loop' : 'intro'}, ${time(s.startSeconds)}-${time(s.startSeconds + s.seconds)}, ${s.lines} lines` +
        `${s.key ? `, key ${s.key}` : ''}`,
    );
    if (s.chords.length) out.push(`  Chords: ${s.chords.map((c) => `${hex(c.line, 2)} ${c.symbol}`).join('  ')}`);
    out.push(
      `  Mix: RMS ${db(s.mix.rmsDb)}, peak ${db(s.mix.peakDb)}, ${clipText(s.mix)}; ` +
        `voices used ${s.voices.maxUsed}, demand ${s.voices.maxDemand}${s.voices.linesOverLimit ? `, ${s.voices.linesOverLimit} lines over the limit` : ''}`,
    );
    out.push(tableHead(a));
    out.push(...trackRows(a, s.tracks));
    if (s.masking.length) {
      out.push(`  Masking: ${s.masking.map((mk) => `${mk.band}: ${mk.tracks.map((t) => trackName(a, t)).join(', ')}`).join('; ')}`);
    }
  }

  out.push('');
  const total = a.diagnostics.reduce((n, g) => n + g.count, 0);
  out.push(`Diagnostics: ${total ? `${total} (${a.diagnostics.map((g) => `${g.count} ${g.kind}`).join(', ')})` : 'none'}`);
  for (const g of a.diagnostics) {
    out.push(`  ${g.kind} (${g.severity}), ${g.count}x:`);
    for (const item of g.items.slice(0, ITEMS_PER_KIND)) out.push(`    ${where(item.position, a)}: ${item.message}`);
    if (g.items.length > ITEMS_PER_KIND) out.push(`    ... and ${g.items.length - ITEMS_PER_KIND} more (--json lists all)`);
  }
  out.push('');
  out.push(`Comments: ${a.comments.length || 'none'}`);
  for (const c of a.comments) {
    const plays = c.plays.length ? ` (plays at ${c.plays.map((p) => time(p.seconds)).join(', ')})` : ' (not in the song)';
    const track = c.track === null ? 'whole line' : `T${c.track + 1} ${c.trackLabel ?? ''}`.trim();
    out.push(`  ${c.patternName} ${hex(c.line, 2)} ${track}${plays}: ${c.text}`);
  }
  return out.join('\n') + '\n';
}
