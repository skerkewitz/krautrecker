import { describe, expect, it } from 'vitest';
import { compileSong } from '../compiler/compile';
import { device, fixture } from '../compiler/fixtures';
import { buildSample } from '../brr/sampleBuild';
import { SDsp } from '../dsp/sdsp';
import { Sequencer } from '../dsp/sequencer';
import { parseWav, encodeWav16 } from '../io/wav';
import { newPattern, newTrack } from '../model/defaults';
import { NOTE_OFF, type Cell, type Project } from '../model/types';
import { analyzeSong } from './analyze';
import { bandShares, measurePitches, tuningStats } from './measure';
import { renderSong, type SongRender } from './render';
import { formatAnalysis } from './report';

/** Largest |mix - sum of stems| over the render, in int16 steps. */
function residual(r: SongRender): number {
  let max = 0;
  for (const ch of ['left', 'right'] as const) {
    for (let i = 0; i < r.totalSamples; i++) {
      let sum = 0;
      for (const s of r.stems) sum += s.audio[ch][i];
      max = Math.max(max, Math.abs(r.mix.audio[ch][i] - sum));
    }
  }
  return max * 32768;
}

function energy(r: SongRender): number {
  let e = 0;
  for (let i = 0; i < r.totalSamples; i++) e += r.mix.audio.left[i] ** 2 + r.mix.audio.right[i] ** 2;
  return e;
}

/** Two tracks with echo, pan and volumes low enough that nothing clips. */
function twoTracks(patch: (p: Project) => void = () => {}): Project {
  return fixture(
    [
      { device: device('lead', 'mono', { volume: 60, pan: -20, echo: true }), cells: [[0, 0, { note: 64 }], [8, 0, { note: 67 }], [14, 0, { note: NOTE_OFF }]] },
      { device: device('pad', 'poly', { volume: 40, pan: 30 }), columns: 2, cells: [[2, 0, { note: 48 }], [2, 1, { note: 55 }], [12, 0, { note: NOTE_OFF }]] },
    ],
    (p) => {
      p.hardware.echo = { delay: 2, feedback: 0x40, volumeL: 0x30, volumeR: 0x30, fir: [96, 16, 8, 4, 2, 1, 0, 0], writeEnabled: true };
      patch(p);
    },
  );
}

describe('render', () => {
  it('renders the song length the sequencer plays: 16 lines x 6 ticks x 640 samples at 125 BPM', () => {
    const p = fixture([{ device: device('d', 'mono'), cells: [[0, 0, { note: 60 }]] }]);
    const r = renderSong(p, { tailSeconds: 0, stems: false });
    expect(r.songSamples).toBe(16 * 6 * 640);
    expect(r.totalSamples).toBe(r.songSamples);
    expect(r.mix.audio.left.length).toBe(61440);
  });

  it('follows tempo changes exactly as the sequencer does, and adds the tail', () => {
    // F A0 on line 8: 160 BPM, 500 samples per tick for the second half.
    const p = fixture([{ device: device('d', 'mono'), cells: [[0, 0, { note: 60 }], [8, 0, { fx: [{ type: 'tempo', value: 0xa0 }] }]] }]);
    const r = renderSong(p, { tailSeconds: 0.5, stems: false });
    expect(r.songSamples).toBe(48 * 640 + 48 * 500);
    expect(r.totalSamples).toBe(r.songSamples + 16000);

    // The real sequencer has fired exactly the last tick at songSamples, and stops on the next sample.
    const ir = compileSong(p);
    const dsp = new SDsp();
    dsp.setSamples(p.samples.map((s) => buildSample(s)).map((b) => ({ brr: b.brr, loopBlock: b.loopBlock })));
    const seq = new Sequencer(dsp);
    seq.load(ir);
    seq.play(0, null, false);
    const buf = () => new Float32Array(r.songSamples + 1);
    const [l, rr] = [buf(), buf()];
    seq.render(l, rr, 0, r.songSamples);
    expect(seq.tick).toBe(ir.totalTicks);
    expect(seq.playing).toBe(true);
    seq.render(l, rr, r.songSamples, 1);
    expect(seq.playing).toBe(false);
  });

  it('splits the render into segments at every order entry, the song end and the tail', () => {
    const p = twoTracks((q) => {
      q.order = ['pat_1', 'pat_1'];
    });
    const r = renderSong(p, { tailSeconds: 1, stems: false });
    expect(r.segments).toEqual([0, 61440, 122880, 122880 + 32000]);
    expect(r.mix.clips).toHaveLength(3);
  });
});

describe('stems', () => {
  // Without clipping the stems add up to the mix except for integer rounding: main volume and the
  // echo filter round each stem's sum separately (measured: 1 int16 step with echo, 0 without).
  // Clipping is the one large nonlinearity, tested below.
  const TOLERANCE_STEPS = 4;

  it('render one stem per sounding track, adding up to the mix (echo included)', () => {
    const r = renderSong(twoTracks(), { tailSeconds: 1 });
    expect(r.stems.map((s) => s.track)).toEqual([0, 1]);
    expect(energy(r)).toBeGreaterThan(1);
    expect(r.mix.clips.reduce((n, c) => n + c.voice + c.echo + c.output, 0)).toBe(0);
    expect(residual(r)).toBeLessThanOrEqual(TOLERANCE_STEPS);
  });

  it('end a stolen note in its own stem exactly where the mix ends it', () => {
    // One usable voice: the pad's chord steals the lead's voice; then the lead takes it back.
    const r = renderSong(
      twoTracks((p) => {
        p.hardware.reservedSfxVoices = 7;
      }),
      { tailSeconds: 0.2 },
    );
    expect(r.ir.diagnostics.some((d) => d.kind === 'voiceStolen')).toBe(true);
    expect(residual(r)).toBeLessThanOrEqual(TOLERANCE_STEPS);
  });

  it('keep pitch modulation in the modulated stem', () => {
    const r = renderSong(
      fixture([
        { device: device('mod', 'mono', { volume: 0 }), cells: [[0, 0, { note: 66 }]] },
        { device: device('car', 'mono', { volume: 60, pitchModSource: 'mod' }), cells: [[0, 0, { note: 60 }]] },
      ]),
      { tailSeconds: 0 },
    );
    expect(r.ir.voices.flat().some((e) => e.type === 'pitchMod' && e.enabled)).toBe(true);
    expect(residual(r)).toBeLessThanOrEqual(TOLERANCE_STEPS);
  });

  it('show clipping inside the DSP that the output level hides', () => {
    // Eight loud notes on two tracks: the voice mix clamps at 16 bits, main volume then scales it
    // down. Each stem alone stays below the clamp, so the stems no longer add up to the mix.
    const cells = Array.from({ length: 4 }, (_, c): [number, number, Cell] => [0, c, { note: 60 }]);
    const loud = fixture(
      [
        { device: device('p', 'poly', { volume: 127, maxVoices: 4 }), columns: 4, cells },
        { device: device('q', 'poly', { volume: 127, maxVoices: 4 }), columns: 4, cells },
      ],
      (p) => {
        p.hardware.mainVolumeL = 40;
        p.hardware.mainVolumeR = 40;
      },
    );
    const r = renderSong(loud, { tailSeconds: 0 });
    const a = analyzeSong(loud, r);
    expect(a.whole.mix.clips.voice).toBeGreaterThan(0);
    expect(a.whole.mix.clips.output).toBe(0);
    expect(a.whole.mix.peakDb).toBeLessThan(-6);
    expect(a.whole.stemResidual).toBeGreaterThan(1000);
  });
});

describe('tuning', () => {
  const tuned = (patch: (p: Project) => void, mode: 'mono' | 'legato' = 'mono') =>
    fixture([{ device: device('d', mode), cells: [[0, 0, { note: 60 }], [4, 0, { note: 67 }], [8, 0, { note: 71 }], [12, 0, { note: 52 }]] }], patch);
  const cents = (p: Project) => {
    const r = renderSong(p, { tailSeconds: 0, stems: false });
    return measurePitches(p, r.ir, r.built);
  };

  it('measures a device detune from the pitch register', () => {
    const pitches = cents(tuned((p) => (p.devices[0].fineTune = 7)));
    expect(pitches).toHaveLength(4);
    for (const x of pitches) expect(Math.abs(x.cents - 7)).toBeLessThan(0.5);
    expect(tuningStats(pitches).meanCents).toBeCloseTo(7, 0);
  });

  it('takes the sample fine tune as the sample\'s own tuning, so its correction is in tune', () => {
    const pitches = cents(tuned((p) => (p.samples[0].fineTune = 30)));
    for (const x of pitches) expect(Math.abs(x.cents)).toBeLessThan(0.5);
    // A wrong root note is not a tuning error: the note lands on another semitone.
    const shifted = cents(tuned((p) => (p.samples[0].rootNote = 61)));
    for (const x of shifted) expect(Math.abs(x.cents)).toBeLessThan(0.5);
  });

  it('counts legato note changes and skips noise voices', () => {
    const legato = cents(tuned(() => {}, 'legato'));
    expect(legato.map((x) => x.kind)).toEqual(['keyOn', 'legato', 'legato', 'legato']);
    const noise = cents(tuned((p) => (p.devices[0].zones[0].noise = 20)));
    expect(noise).toEqual([]);
  });
});

describe('measurements', () => {
  const sine = (hz: number) => {
    const n = 32000;
    const left = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / 32000));
    return { left, right: left.slice() };
  };

  it('puts a sine into its band', () => {
    expect(bandShares(sine(100), 0, 32000)[0]).toBeGreaterThan(0.99);
    expect(bandShares(sine(440), 0, 32000)[1]).toBeGreaterThan(0.99);
    expect(bandShares(sine(1500), 0, 32000)[2]).toBeGreaterThan(0.99);
    expect(bandShares(sine(6000), 0, 32000)[3]).toBeGreaterThan(0.99);
    expect(bandShares({ left: new Float32Array(4096), right: new Float32Array(4096) }, 0, 4096)).toEqual([0, 0, 0, 0]);
  });

  it('writes 16-bit stereo WAV files that read back sample-exact', () => {
    const left = Float32Array.from([0, 0.5, -0.5, -1, 32767 / 32768]);
    const wav = encodeWav16(left, left, 32000);
    const back = parseWav(wav.buffer as ArrayBuffer);
    expect(back.sampleRate).toBe(32000);
    expect(Array.from(back.data)).toEqual(Array.from(left));
  });
});

describe('analysis', () => {
  function song(): Project {
    const p = twoTracks((q) => {
      q.key = { root: 4, mode: 'dorian' };
      const b = newPattern('B', 8, [newTrack('lead', 1, 8), newTrack('pad', 2, 8)], 'pat_2');
      b.tracks[0].cells[0][0] = { note: 71 };
      b.key = { root: 9, mode: 'dorian' };
      b.chords = [{ line: 0, symbol: 'Am' }];
      b.comments = [{ id: 'c1', line: 4, track: 0, text: 'lead too loud?' }];
      q.patterns.push(b);
      q.order = ['pat_1', 'pat_2', 'pat_2'];
      q.loopOrderIndex = 1;
    });
    p.patterns[0].name = 'A';
    return p;
  }

  it('reports sections, tracks, harmony, comments and voices', () => {
    const p = song();
    const a = analyzeSong(p, renderSong(p, { tailSeconds: 0.5 }));
    expect(a.key).toBe('E dorian');
    expect(a.sections.map((s) => [s.orderIndex, s.patternName, s.inLoop, s.lines, s.key])).toEqual([
      [0, 'A', false, 16, 'E dorian'],
      [1, 'B', true, 8, 'A dorian'],
      [2, 'B', true, 8, 'A dorian'],
    ]);
    expect(a.sections[1].startSeconds).toBeCloseTo((16 * 6 * 640) / 32000, 6);
    expect(a.sections[1].chords).toEqual([{ line: 0, symbol: 'Am' }]);
    expect(a.tracks.map((t) => t.label)).toEqual(['lead', 'pad']);
    const shares = a.sections[0].tracks.map((t) => t.share);
    expect(shares.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
    expect(a.comments).toEqual([
      {
        patternId: 'pat_2',
        patternName: 'B',
        line: 4,
        track: 0,
        trackLabel: 'lead',
        text: 'lead too loud?',
        plays: [
          { orderIndex: 1, seconds: ((16 + 4) * 6 * 640) / 32000 },
          { orderIndex: 2, seconds: ((24 + 4) * 6 * 640) / 32000 },
        ],
      },
    ]);
    expect(a.voices).toMatchObject({ usable: 8, maxDemand: 3, linesOverLimit: 0, stolen: 0 });
    expect(a.tracks[0].tuning.notes).toBe(4);
  });

  it('groups diagnostics by kind with their position', () => {
    const p = song();
    p.patterns[0].tracks[1].deviceId = null;
    const a = analyzeSong(p, renderSong(p, { tailSeconds: 0, stems: false }));
    const g = a.diagnostics.find((d) => d.kind === 'noDevice');
    expect(g?.count).toBeGreaterThan(0);
    expect(g?.items[0].position).toMatchObject({ patternName: 'A', track: 1, line: 2 });
  });

  it('flags masking when two loud tracks share their main band', () => {
    const p = fixture([
      { device: device('a', 'mono', { volume: 60 }), cells: [[0, 0, { note: 60 }]] },
      { device: device('b', 'mono', { volume: 60 }), cells: [[0, 0, { note: 62 }]] },
    ]);
    const a = analyzeSong(p, renderSong(p, { tailSeconds: 0 }));
    expect(a.sections[0].masking.length).toBeGreaterThan(0);
    expect(a.sections[0].masking[0].tracks).toEqual([0, 1]);
  });

  it('formats a readable report', () => {
    const p = song();
    const text = formatAnalysis(analyzeSong(p, renderSong(p, { tailSeconds: 0.5 })));
    expect(text).toContain('Key E dorian');
    expect(text).toContain('[1] "B" loop');
    expect(text).toContain('Chords: 00 Am');
    expect(text).toContain('B 04 T1 lead (plays at 0:02.4, 0:03.4): lead too loud?');
    expect(text).toMatch(/T1 lead\s+4 notes/);
  });
});
