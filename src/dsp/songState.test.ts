import { describe, expect, it } from 'vitest';
import { encodeBrr } from '../brr/brr';
import { buildSample } from '../brr/sampleBuild';
import { compileSong } from '../compiler/compile';
import { device, fixture } from '../compiler/fixtures';
import { newPattern, newTrack } from '../model/defaults';
import type { Cell, EffectType, Project } from '../model/types';
import { SDsp } from './sdsp';
import { Sequencer } from './sequencer';

// Fixture timing: 125 BPM, 4 LPB, 6 ticks per line = 640 samples per tick.

const fx = (type: EffectType, value: number): Cell => ({ fx: [{ type, value }] });

/** A song of patterns, one track each; `cells` per pattern as [line, cell]. */
function song(patterns: { lines: number; cells: [number, Cell][] }[], patch: (p: Project) => void = () => {}): Project {
  const d = device('pad', 'poly');
  return fixture([{ device: d, cells: [] }], (p) => {
    p.patterns = patterns.map((spec, i) => {
      const pat = newPattern(`P${i}`, spec.lines, [newTrack(d.id, 1, spec.lines)], `pat_${i}`);
      for (const [line, cell] of spec.cells) pat.tracks[0].cells[line][0] = cell;
      return pat;
    });
    p.order = p.patterns.map((x) => x.id);
    patch(p);
  });
}

function sequencer(project: Project) {
  const dsp = new SDsp();
  dsp.setSamples(project.samples.map((s) => buildSample(s)).map((b) => ({ brr: b.brr, loopBlock: b.loopBlock })));
  const seq = new Sequencer(dsp);
  const ir = compileSong(project);
  seq.load(ir);
  return { dsp, seq, ir };
}

function run(seq: Sequencer, samples: number): void {
  seq.render(new Float32Array(samples), new Float32Array(samples), 0, samples);
}

describe('tempo changes in playback', () => {
  it('a tempo event changes the samples per tick from its tick on', () => {
    // F FA = 250 BPM on line 1 (tick 6): ticks then last 320 samples instead of 640.
    const { seq } = sequencer(song([{ lines: 8, cells: [[1, fx('tempo', 0xfa)]] }]));
    seq.play(0, 0, false);
    run(seq, 6 * 640);
    expect(seq.tick).toBe(6);
    run(seq, 6 * 320);
    expect(seq.tick).toBe(12);
  });
});

describe('song loop point', () => {
  const twoParts = () =>
    song([{ lines: 4, cells: [[0, fx('mainVolume', 0x20)]] }, { lines: 4, cells: [[2, fx('mainVolume', 0x60)], [3, fx('tempo', 0xfa)]] }], (p) => (p.loopOrderIndex = 1));

  it('after the end, a looping song continues at the IR loop point', () => {
    const { seq, ir } = sequencer(twoParts());
    expect(ir.loopTick).toBe(24);
    seq.play(ir.totalTicks - 1, null, true);
    run(seq, 320 + 2 * 640);
    // One tick at 250 BPM (the song end), then two ticks from the loop point.
    expect(seq.tick).toBe(26);
    expect(seq.playing).toBe(true);
  });

  it('jumping to the loop point restores the state the song has there', () => {
    const { seq, dsp, ir } = sequencer(twoParts());
    seq.play(ir.totalTicks - 1, null, true);
    run(seq, 320);
    expect(dsp.mainVolL).toBe(0x60);
    run(seq, 640);
    // Main volume as set in the intro, and the base tempo (640 samples per tick) again.
    expect(dsp.mainVolL).toBe(0x20);
    expect(seq.tick).toBe(25);
  });

  it('an explicit loop start still wins (pattern play)', () => {
    const { seq, ir } = sequencer(twoParts());
    seq.play(ir.totalTicks - 1, 0, true);
    run(seq, 320 + 640);
    expect(seq.tick).toBe(1);
  });

  it('follows a loop point changed while playing', () => {
    const p = twoParts();
    const { seq, ir } = sequencer(p);
    seq.play(ir.totalTicks - 1, null, true);
    seq.load(compileSong({ ...p, loopOrderIndex: 0 }));
    run(seq, 320 + 640);
    expect(seq.tick).toBe(1);
  });
});

describe('starting mid-song', () => {
  const project = () =>
    song([
      {
        lines: 16,
        cells: [
          [1, fx('mainVolume', 0x30)],
          [2, fx('echoVolume', 0x40)],
          [3, fx('echoWrite', 0)],
          [4, fx('tempo', 0xfa)],
          [10, fx('mainVolume', 0x70)],
        ],
      },
    ]);

  it('applies the tempo, volumes and echo state the song has at the start tick', () => {
    const { seq, dsp } = sequencer(project());
    seq.play(8 * 6, 0, false);
    expect(dsp.mainVolL).toBe(0x30);
    expect(dsp.echoWrite).toBe(false);
    run(seq, 4 * 320);
    expect(seq.tick).toBe(8 * 6 + 4);
  });

  it('starting from the top again resets that state', () => {
    const { seq, dsp } = sequencer(project());
    seq.play(8 * 6, 0, false);
    run(seq, 100);
    seq.play(0, 0, false);
    run(seq, 640);
    expect(dsp.mainVolL).toBe(100);
    expect(dsp.echoWrite).toBe(true);
    expect(seq.tick).toBe(1);
  });

  it('recompiling while playing keeps the state at the play position', () => {
    const p = project();
    const { seq, dsp } = sequencer(p);
    seq.play(8 * 6, 0, false);
    run(seq, 320);
    seq.load(compileSong(p));
    expect(dsp.mainVolL).toBe(0x30);
    expect(dsp.echoWrite).toBe(false);
    run(seq, 3 * 320);
    expect(seq.tick).toBe(8 * 6 + 4);
  });
});

describe('echo write enable (FLG bit 5)', () => {
  /** Plays a note into a 16 ms echo, then silences all voices. Returns the DSP. */
  function echoed(): SDsp {
    const pcm = Int16Array.from({ length: 128 }, (_, i) => (i % 32 < 16 ? 12000 : -12000));
    const enc = encodeBrr(pcm, 0);
    const dsp = new SDsp();
    dsp.setSamples([{ brr: enc.data, loopBlock: enc.loopBlock }]);
    dsp.setMainVolume(0, 0); // hear only the echo
    dsp.setEcho({ delay: 1, feedback: 0, volumeL: 127, volumeR: 127, fir: [127, 0, 0, 0, 0, 0, 0, 0] });
    dsp.keyOn(0, { sampleSlot: 0, pitch: 0x1000, volL: 100, volR: 100, envelope: { mode: 'adsr', attack: 15, decay: 7, sustainLevel: 7, sustainRate: 0 }, echo: true });
    render(dsp, 2048);
    dsp.silence();
    return dsp;
  }

  function render(dsp: SDsp, n: number): Float32Array {
    const l = new Float32Array(n);
    dsp.render(l, new Float32Array(n), 0, n);
    return l;
  }

  const energy = (x: Float32Array) => x.reduce((a, v) => a + v * v, 0);

  it('a frozen buffer keeps repeating its content', () => {
    const dsp = echoed();
    dsp.setEchoWrite(false);
    // 512 frames = one pass through the 16 ms buffer.
    render(dsp, 512);
    const a = render(dsp, 512);
    const b = render(dsp, 512);
    expect(energy(a)).toBeGreaterThan(1);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('with writes enabled and no feedback, the echo dies after one pass', () => {
    const dsp = echoed();
    // One pass plus the 8-sample FIR history.
    render(dsp, 520);
    expect(energy(render(dsp, 512))).toBe(0);
  });

  it('enabling writes again records new input', () => {
    const dsp = echoed();
    dsp.setEchoWrite(false);
    render(dsp, 512);
    dsp.setEchoWrite(true);
    render(dsp, 520);
    expect(energy(render(dsp, 512))).toBe(0);
  });
});
