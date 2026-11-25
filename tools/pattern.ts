import { readFileSync, writeFileSync } from 'node:fs';
import { patternToText, patternWithBlock, textToBlock, PatternTextError } from '../src/io/patternText';
import { serializeProject } from '../src/io/projectFile';
import type { Project } from '../src/model/types';
import { fail, loadProject, parseArgs } from './cli';

/**
 * npm run pattern -- export <project.json | demo> <pattern-id | name> [out.txt]
 * npm run pattern -- import <project.json | demo> <pattern-id | name> <in.txt> [--out project.json]
 *
 * Export prints (or writes) a pattern as pattern text; import replaces a pattern's cells with the
 * text and writes the project back (to --out, else in place; "demo" needs --out). Tracks keep
 * their devices.
 */

const USAGE = [
  'Usage:',
  '  npm run pattern -- export <project.json | demo> <pattern-id | name> [out.txt]',
  '  npm run pattern -- import <project.json | demo> <pattern-id | name> <in.txt> [--out project.json]',
].join('\n');

function findPattern(project: Project, ref: string) {
  const pattern = project.patterns.find((p) => p.id === ref) ?? project.patterns.find((p) => p.name === ref);
  if (!pattern) fail(`No pattern "${ref}". Patterns: ${project.patterns.map((p) => `${p.id} ("${p.name}")`).join(', ')}`);
  return pattern;
}

function load(arg: string): Project {
  try {
    return loadProject(arg);
  } catch (e) {
    fail(`Cannot load ${arg}: ${(e as Error).message}`);
  }
}

const { positional, options } = parseArgs(process.argv.slice(2), ['out']);
const [command, file, ref, path] = positional;

if (command === 'export' && file && ref && positional.length <= 4) {
  const project = load(file);
  const pattern = findPattern(project, ref);
  const names = pattern.tracks.map((t) => project.devices.find((d) => d.id === t.deviceId)?.name ?? '(no device)');
  const text = patternToText(pattern, names);
  if (path) writeFileSync(path, text);
  else process.stdout.write(text);
} else if (command === 'import' && file && ref && path && positional.length === 4) {
  if (file === 'demo' && !options.has('out')) fail('Importing into the demo song needs --out <project.json>.');
  const project = load(file);
  const pattern = findPattern(project, ref);
  let next;
  try {
    next = patternWithBlock(pattern, textToBlock(readFileSync(path, 'utf8')));
  } catch (e) {
    fail(e instanceof PatternTextError ? `${path}, ${e.message}` : (e as Error).message);
  }
  const updated: Project = { ...project, patterns: project.patterns.map((p) => (p.id === pattern.id ? next : p)) };
  const out = options.get('out');
  const target = typeof out === 'string' ? out : file;
  writeFileSync(target, serializeProject(updated));
  process.stderr.write(`Pattern "${pattern.name}" (${pattern.id}): ${next.lines} lines imported into ${target}.\n`);
} else fail(USAGE);
