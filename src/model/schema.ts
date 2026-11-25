import { emptyProject, SCHEMA_VERSION } from './defaults';
import type { Project } from './types';

/**
 * Loading and migrating project files. Every file carries `schemaVersion`; each migration lifts
 * a project by one version, so old files always load into the current model.
 */

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/** MIGRATIONS[n] lifts version n to n + 1. None yet: version 1 is the first. */
const MIGRATIONS: Record<number, Migration> = {};

export class ProjectFormatError extends Error {}

export function migrate(input: unknown): Project {
  if (!input || typeof input !== 'object') throw new ProjectFormatError('Not a project file.');
  let raw = input as Record<string, unknown>;
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
function normalize(raw: Record<string, unknown>): Project {
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
  };
}
