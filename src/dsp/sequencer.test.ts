import { describe, expect, it } from 'vitest';
import { buildSample } from '../brr/sampleBuild';
import { compileSong } from '../compiler/compile';
import { demoProject } from '../model/demo';
import { SDsp } from './sdsp';
import { Sequencer } from './sequencer';

function setup() {
  const project = demoProject();
  const ir = compileSong(project);
  const dsp = new SDsp();
  dsp.setSamples(project.samples.map((s) => buildSample(s)).map((b) => ({ brr: b.brr, loopBlock: b.loopBlock })));
  const seq = new Sequencer(dsp);
  seq.load(ir);
  return { project, ir, dsp, seq };
}

describe('sequencer playing the compiled demo song', () => {
  it('advances ticks at the tempo: 125 BPM, 4 LPB, 6 TPL = 640 samples per tick', () => {
    const { seq } = setup();
    seq.play(0, 0, false);
    const l = new Float32Array(6400);
    const r = new Float32Array(6400);
    seq.render(l, r, 0, 6400);
    expect(seq.tick).toBe(10);
  });

  it('produces audible, finite, unclipped output', () => {
    const { seq } = setup();
    seq.play(0, 0, false);
    const n = 32000 * 3;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    seq.render(l, r, 0, n);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(l[i])).toBe(true);
      sum += l[i] * l[i] + r[i] * r[i];
      peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    }
    const rms = Math.sqrt(sum / (2 * n));
    expect(rms).toBeGreaterThan(0.02);
    expect(peak).toBeLessThan(1);
  });

  it('stops at the end of the song unless looping', () => {
    const { ir, seq } = setup();
    seq.play(ir.totalTicks - 2, 0, false);
    const l = new Float32Array(4000);
    const r = new Float32Array(4000);
    seq.render(l, r, 0, 4000);
    expect(seq.playing).toBe(false);

    seq.play(ir.totalTicks - 2, 5, true);
    seq.render(l, r, 0, 4000);
    expect(seq.playing).toBe(true);
    expect(seq.tick).toBeGreaterThan(5);
    expect(seq.tick).toBeLessThan(20);
  });
});
