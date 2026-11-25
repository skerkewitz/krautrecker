import { DEVICE_DEFAULTS, emptyProject, SCHEMA_VERSION, TRACK_DEFAULTS } from './defaults';
import type { Device, Pattern, Project, Track } from './types';

/**
 * Loading and migrating project files. Every file carries `schemaVersion`; each migration lifts
 * a project by one version, so old files always load into the current model.
 */

type Raw = Record<string, unknown>;
type Migration = (raw: Raw) => Raw;

/** MIGRATIONS[n] lifts version n to n + 1. */
const MIGRATIONS: Record<number, Migration> = {
  // 1 -> 2: a cell's single effect becomes a list of effect columns; one main volume becomes
  // left/right. New device, track and song fields get their neutral defaults in `normalize`.
  1: (raw) => {
    const patterns = (raw.patterns as Raw[] | undefined)?.map((pat) => ({
      ...pat,
      tracks: (pat.tracks as Raw[]).map((t) => ({
        ...t,
        cells: (t.cells as (Raw | null)[][]).map((row) => row.map((cell) => (cell && cell.fx && !Array.isArray(cell.fx) ? { ...cell, fx: [cell.fx] } : cell))),
      })),
    }));
    const hw = (raw.hardware ?? {}) as Raw;
    const mv = typeof hw.mainVolume === 'number' ? hw.mainVolume : 100;
    const { mainVolume: _old, ...rest } = hw;
    return { ...raw, patterns, hardware: { ...rest, mainVolumeL: mv, mainVolumeR: mv }, schemaVersion: 2 };
  },
};

export class ProjectFormatError extends Error {}

export function migrate(input: unknown): Project {
  if (!input || typeof input !== 'object') throw new ProjectFormatError('Not a project file.');
  let raw = input as Raw;
  let version = raw.schemaVersion;
  if (typeof version !== 'number') throw new ProjectFormatError('Missing schemaVersion.');
  if (version > SCHEMA_VERSION) {
    throw new ProjectFormatError(`This project was saved by a newer version (schema ${version}); this build reads up to ${SCHEMA_VERSION}.`);
  }
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new ProjectFormatError(`No migration from schema ${version}.`);
    raw = step(raw);
    version++;
  }
  return normalize(raw);
}

/** Fills missing optional fields with defaults and checks the required structure. */
function normalize(raw: Raw): Project {
  const base = emptyProject();
  const p = raw as unknown as Project;
  for (const key of ['samples', 'devices', 'patterns', 'order'] as const) {
    if (!Array.isArray(p[key])) throw new ProjectFormatError(`Field "${key}" must be a list.`);
  }
  return {
    ...base,
    ...p,
    schemaVersion: SCHEMA_VERSION,
    timing: { ...base.timing, ...p.timing },
    hardware: { ...base.hardware, ...p.hardware, echo: { ...base.hardware.echo, ...p.hardware?.echo } },
    loopOrderIndex: typeof p.loopOrderIndex === 'number' ? p.loopOrderIndex : 0,
    devices: p.devices.map(normalizeDevice),
    patterns: p.patterns.map(normalizePattern),
  };
}

function normalizeDevice(d: Device): Device {
  return {
    ...DEVICE_DEFAULTS,
    ...d,
    release: { ...DEVICE_DEFAULTS.release, ...d.release },
    vibrato: d.vibrato ? { ...d.vibrato, fadeIn: d.vibrato.fadeIn ?? 0 } : null,
  };
}

function normalizePattern(pat: Pattern): Pattern {
  return { ...pat, tracks: pat.tracks.map((t: Track) => ({ ...TRACK_DEFAULTS, ...t })) };
}
