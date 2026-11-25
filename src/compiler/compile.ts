import { buildSample, type BuiltSample } from '../brr/sampleBuild';
import { DSP_RATE } from '../dsp/tables';
import type { Pattern, PatternId, Project } from '../model/types';
import { allocateVoices, describeNote } from './allocate';
import { expandTrack, type ExpandContext, type SongPattern } from './expand';
import { ARAM_CAPACITY, VOICE_COUNT, type AramEstimate, type Diagnostic, type IR, type LineInfo } from './ir';

export interface CompileOptions {
  /** Compile this arrangement instead of the project's order list (e.g. a single pattern). */
  order?: PatternId[];
}

/** Bytes per song event in the song-data estimate (command byte + ~2 argument bytes). */
const BYTES_PER_EVENT = 3;
/** Each sample directory entry holds a start and a loop address: 2 x 16 bits. */
const DIRECTORY_ENTRY_BYTES = 4;

/**
 * Compiles the high-level project to the IR. Pure and deterministic: the same project always
 * yields the same IR, byte for byte. Nothing here reads the clock, the locale or Math.random().
 */
export function compileSong(project: Project, options: CompileOptions = {}): IR {
  const { timing, hardware } = project;
  const tpl = Math.max(1, Math.round(timing.ticksPerLine));
  const samplesPerTick = (DSP_RATE * 60) / (timing.bpm * timing.linesPerBeat * tpl);
  const diagnostics: Diagnostic[] = [];

  // Samples: build BRR (cached per sample) and assign directory slots in project order.
  const samples = new Map(project.samples.map((s) => [s.id, s]));
  const built = new Map<string, BuiltSample>();
  const slots = new Map<string, number>();
  project.samples.forEach((s, i) => {
    const b = buildSample(s);
    built.set(s.id, b);
    slots.set(s.id, i);
    for (const note of b.notes) {
      diagnostics.push({ kind: 'loopRealigned', severity: 'info', message: `Sample "${s.name}": ${note}` });
    }
  });

  // Arrangement.
  const patterns = new Map(project.patterns.map((p) => [p.id, p]));
  const song: SongPattern[] = [];
  const lines: LineInfo[] = [];
  let tick = 0;
  (options.order ?? project.order).forEach((id, orderIndex) => {
    const pattern: Pattern | undefined = patterns.get(id);
    if (!pattern) return;
    song.push({ orderIndex, pattern, startTick: tick });
    for (let l = 0; l < pattern.lines; l++) lines.push({ orderIndex, patternId: id, line: l, tick: tick + l * tpl });
    tick += pattern.lines * tpl;
  });
  const totalTicks = tick;

  // Stage 1 + 2: device logic per track.
  const ctx: ExpandContext = {
    project,
    tpl,
    samplesPerTick,
    devices: new Map(project.devices.map((d) => [d.id, d])),
    samples,
    built,
    slots,
    notes: [],
    globalEvents: [],
    diagnostics,
    diagKeys: new Set(),
    nextId: 0,
  };
  const trackCount = song.reduce((m, sp) => Math.max(m, sp.pattern.tracks.length), 0);
  for (let t = 0; t < trackCount; t++) expandTrack(ctx, t, song);

  // Stage 3: voices. Reserved SFX voices are taken from the top (7, 6, ...).
  const reserved = Math.max(0, Math.min(VOICE_COUNT, Math.round(hardware.reservedSfxVoices)));
  const usable = Array.from({ length: VOICE_COUNT - reserved }, (_, i) => i);
  const reservedVoices = Array.from({ length: reserved }, (_, i) => VOICE_COUNT - reserved + i);
  // Hardware release drops the envelope by 8 per sample from at most 0x7FF: 256 samples.
  const releaseTicks = Math.max(1, Math.ceil(256 / samplesPerTick));
  const deviceName = (id: string) => ctx.devices.get(id)?.name ?? '?';
  const alloc = allocateVoices(ctx.notes, usable, releaseTicks, totalTicks, diagnostics, (n) => describeNote(n, deviceName(n.deviceId)));

  // Voice demand: notes that want a voice at each tick, whether or not they got one.
  const demandDiff = new Int32Array(totalTicks + 1);
  for (const n of ctx.notes) {
    const end = Math.min(n.heldEnd, n.naturalEnd, totalTicks);
    if (end <= n.startTick || n.startTick >= totalTicks) continue;
    demandDiff[n.startTick]++;
    demandDiff[end]--;
  }
  const voiceUsage = lines.map(() => ({ used: 0, demand: 0 }));
  let demand = 0;
  for (let t = 0; t < totalTicks; t++) {
    demand += demandDiff[t];
    const li = Math.floor(t / tpl);
    const u = voiceUsage[li];
    if (!u) continue;
    u.used = Math.max(u.used, alloc.usedPerTick[t]);
    u.demand = Math.max(u.demand, demand);
  }

  const echo = hardware.echo;
  const global: IR['global'] = [
    { tick: 0, type: 'tempo', bpm: timing.bpm },
    {
      tick: 0,
      type: 'echo',
      params: { delay: echo.delay, feedback: echo.feedback, volumeL: echo.volumeL, volumeR: echo.volumeR, fir: echo.fir.slice(0, 8) },
    },
    { tick: 0, type: 'mainVolume', volL: hardware.mainVolumeL, volR: hardware.mainVolumeR },
  ];
  if (!echo.writeEnabled) global.push({ tick: 0, type: 'echoWrite', enabled: false });
  // Events from global effects, in tick order (stable: same-tick events keep their track order).
  global.push(...ctx.globalEvents.map((e, i) => ({ e, i })).sort((a, b) => a.e.tick - b.e.tick || a.i - b.i).map((x) => x.e));

  const aram = estimateAram(project, built, alloc.lanes, global.length);
  if (aram.total > aram.capacity) {
    diagnostics.push({
      kind: 'aramOverBudget',
      severity: 'error',
      message: `ARAM estimate is ${aram.total} bytes, over the 64 KB budget by ${aram.total - aram.capacity} bytes. Lower sample rates, shorten samples or reduce the echo delay.`,
    });
  }

  // Stable order for display: by tick (diagnostics without a tick first).
  const ordered = diagnostics.map((d, i) => ({ d, i })).sort((a, b) => (a.d.tick ?? -1) - (b.d.tick ?? -1) || a.i - b.i);

  return {
    timing: { bpm: timing.bpm, linesPerBeat: timing.linesPerBeat, ticksPerLine: tpl },
    totalTicks,
    loopTick: 0,
    voices: alloc.lanes,
    global,
    reservedVoices,
    sampleSlots: project.samples.map((s) => s.id),
    lines,
    voiceUsage,
    diagnostics: ordered.map((o) => o.d),
    aram,
  };
}

/**
 * Estimates ARAM use. Driver size is an assumption until Milestone 2 picks a driver; song data
 * is estimated from the composer-written IR events (per-tick modulation is driver work).
 */
export function estimateAram(project: Project, built: Map<string, BuiltSample>, lanes: IR['voices'], globalEvents: number): AramEstimate {
  const samples = project.samples.map((s) => ({ sampleId: s.id, bytes: built.get(s.id)?.brr.length ?? 0 }));
  const samplesTotal = samples.reduce((a, s) => a + s.bytes, 0);
  const delay = Math.max(0, Math.min(15, project.hardware.echo.delay));
  // Each 16 ms of delay is 512 stereo frames of 4 bytes. Even delay 0 uses 4 bytes.
  const echo = delay === 0 ? 4 : delay * 2048;
  let events = globalEvents;
  for (const lane of lanes) for (const e of lane) if (!e.auto) events++;
  const song = events * BYTES_PER_EVENT;
  const directory = project.samples.length * DIRECTORY_ENTRY_BYTES;
  const driver = project.hardware.driverReserve;
  return {
    driver,
    directory,
    samples,
    samplesTotal,
    echo,
    song,
    total: driver + directory + samplesTotal + echo + song,
    capacity: ARAM_CAPACITY,
  };
}
