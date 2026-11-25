import { readFileSync } from 'node:fs';
import { parseProject } from '../src/io/projectFile';
import { demoProject } from '../src/model/demoSong';
import type { Project } from '../src/model/types';

/** Shared helpers of the command-line tools. */

/** A project file path, or "demo" for the built-in demo song. */
export function loadProject(arg: string): Project {
  if (arg === 'demo') return demoProject();
  return parseProject(readFileSync(arg, 'utf8'));
}

export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Splits argv into positional arguments and `--name value` / `--flag` options. */
export function parseArgs(argv: string[], valued: string[]): { positional: string[]; options: Map<string, string | true> } {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (valued.includes(name)) {
      const value = argv[++i];
      if (value === undefined) fail(`--${name} needs a value`);
      options.set(name, value);
    } else options.set(name, true);
  }
  return { positional, options };
}
