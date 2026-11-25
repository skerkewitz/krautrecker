import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeSong } from '../src/analysis/analyze';
import { renderSong } from '../src/analysis/render';
import { formatAnalysis } from '../src/analysis/report';
import { encodeWav16 } from '../src/io/wav';
import { fail, loadProject, parseArgs } from './cli';

/**
 * npm run analyze -- <project.json | demo> [--wav out.wav] [--stems out-dir] [--json]
 *
 * Renders the song (intro once, loop once) through the real playback path and prints the
 * analysis. All measuring lives in src/analysis; this file only reads and writes files.
 */

const USAGE = 'Usage: npm run analyze -- <project.json | demo> [--wav out.wav] [--stems out-dir] [--json]';

const { positional, options } = parseArgs(process.argv.slice(2), ['wav', 'stems']);
if (positional.length !== 1 || options.has('help')) fail(USAGE);
const unknown = [...options.keys()].filter((k) => !['wav', 'stems', 'json'].includes(k));
if (unknown.length) fail(`Unknown option --${unknown[0]}\n${USAGE}`);

let project;
try {
  project = loadProject(positional[0]);
} catch (e) {
  fail(`Cannot load ${positional[0]}: ${(e as Error).message}`);
}
const render = renderSong(project);
const analysis = analyzeSong(project, render);

const wav = options.get('wav');
if (typeof wav === 'string') writeFileSync(wav, encodeWav16(render.mix.audio.left, render.mix.audio.right, render.sampleRate));
const stems = options.get('stems');
if (typeof stems === 'string') {
  mkdirSync(stems, { recursive: true });
  for (const s of render.stems) {
    const label = analysis.tracks[s.track]?.label ?? 'track';
    const name = `${String(s.track + 1).padStart(2, '0')}-${label.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '')}.wav`;
    writeFileSync(join(stems, name), encodeWav16(s.audio.left, s.audio.right, render.sampleRate));
  }
}

process.stdout.write(options.has('json') ? JSON.stringify(analysis, null, 2) + '\n' : formatAnalysis(analysis));
