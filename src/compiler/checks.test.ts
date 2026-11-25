import { describe, expect, it } from 'vitest';
import { demoProject } from '../model/demoSong';
import { NOTE_OFF, type Cell, type Device, type Project, type Sample } from '../model/types';
import { int16ToBase64 } from '../util/base64';
import { compileSong } from './compile';
import { device, fixture, type TrackSpec } from './fixtures';
import type { Diagnostic, DiagnosticKind } from './ir';

const of = (ir: { diagnostics: Diagnostic[] }, kind: DiagnosticKind) => ir.diagnostics.filter((d) => d.kind === kind);
const music = (ir: { diagnostics: Diagnostic[] }) => ir.diagnostics.filter((d) => d.category === 'music');

/** A note held from `line` until a note-off `length` lines later. */
function held(line: number, note: number, length: number, column = 0): [number, number, Cell][] {
  return [
    [line, column, { note }],
    [line + length, column, { note: NOTE_OFF }],
  ];
}

/** A looping single-cycle wave at 32 kHz with root C-4 (60): 32 samples = 1 kHz. */
function wave(id: string, fn: (i: number) => number): Sample {
  return {
    id,
    name: id,
    pcm: int16ToBase64(Int16Array.from({ length: 64 }, (_, i) => Math.round(fn(i)))),
    sampleRate: 32000,
    targetRate: 32000,
    rootNote: 60,
    fineTune: 0,
    loop: { enabled: true, start: 0 },
  };
}

/** A naive square: odd harmonics up to 15 kHz, the brightest at about -34 dB after interpolation. */
const bright = () => wave('smp_bright', (i) => (i % 32 < 16 ? 8000 : -8000));
const dull = () => wave('smp_dull', (i) => 8000 * Math.sin((2 * Math.PI * i) / 32));

function withSample(dev: Device, sampleId: string, patch: Partial<Device> = {}): Device {
  return { ...dev, zones: [{ ...dev.zones[0], sampleId }], ...patch };
}

function song(tracks: TrackSpec[], patch: (p: Project) => void = () => {}, lines = 16): Project {
  return fixture(
    tracks,
    (p) => {
      p.samples.push(bright(), dull());
      patch(p);
    },
    lines,
  );
}

describe('aliasing', () => {
  it('warns when a bright sample is pitched above its clean range', () => {
    const lead = withSample(device('lead', 'mono'), 'smp_bright');
    const ir = compileSong(song([{ device: lead, cells: [[0, 0, { note: 72 }]] }]));
    const [d, ...rest] = of(ir, 'aliasing');
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ severity: 'warning', category: 'hardware', source: { line: 0, track: 0 } });
    // 15 kHz at the root (C-4) leaves room for one semitone: C#4 is the last clean note.
    expect(d.message).toContain('"lead"');
    expect(d.message).toContain('"smp_bright"');
    expect(d.message).toContain('C-5');
    expect(d.message).toContain('clean up to C#4');
  });

  it('stays quiet for the same sample at its root, and for a dull sample pitched up', () => {
    const atRoot = compileSong(song([{ device: withSample(device('a', 'mono'), 'smp_bright'), cells: [[0, 0, { note: 60 }]] }]));
    expect(of(atRoot, 'aliasing')).toEqual([]);
    const sine = compileSong(song([{ device: withSample(device('b', 'mono'), 'smp_dull'), cells: [[0, 0, { note: 84 }]] }]));
    expect(of(sine, 'aliasing')).toEqual([]);
  });

  it('reports each zone once, at its worst note', () => {
    const lead = withSample(device('lead', 'mono'), 'smp_bright');
    const ir = compileSong(song([{ device: lead, cells: [[0, 0, { note: 64 }], [2, 0, { note: 79 }], [4, 0, { note: 67 }]] }]));
    const found = of(ir, 'aliasing');
    expect(found.length).toBe(1);
    expect(found[0].message).toContain('at G-5');
    expect(found[0].source?.line).toBe(2);
  });

  it('counts pitch raised after the key-on (slides)', () => {
    const lead = withSample(device('lead', 'mono'), 'smp_bright');
    const ir = compileSong(song([{ device: lead, cells: [[0, 0, { note: 60, fx: [{ type: 'slideUp', value: 0x40 }] }]] }]));
    expect(of(ir, 'aliasing').length).toBe(1);
  });

  it('skips pitch-modulated notes, whose pitch cannot be predicted', () => {
    const mod = withSample(device('mod', 'mono'), 'smp_dull');
    const car = withSample(device('car', 'mono', { pitchModSource: 'mod' }), 'smp_bright');
    const ir = compileSong(
      song([
        { device: mod, cells: [[0, 0, { note: 60 }]] },
        { device: car, cells: [[0, 0, { note: 72 }]] },
      ]),
    );
    expect(of(ir, 'aliasing')).toEqual([]);
  });
});

describe('detune', () => {
  const tracks = (fineTune: number, leadCells: [number, number, Cell][] = held(0, 64, 8)): TrackSpec[] => [
    { device: device('pad', 'poly'), cells: held(0, 60, 8) },
    { device: device('lead', 'mono', { fineTune }), cells: leadCells },
  ];

  it('notes devices that sound together more than 5 cents apart', () => {
    const ir = compileSong(fixture(tracks(8)));
    const found = of(ir, 'detune');
    expect(found.length).toBe(1);
    expect(found[0]).toMatchObject({ severity: 'info', category: 'music' });
    expect(found[0].message).toContain('"pad" and "lead"');
    expect(found[0].message).toContain('8.2 cents apart');
    expect(found[0].message).toContain('device fine tune +8.0 cents');
  });

  it('stays quiet for small differences and for devices that never overlap', () => {
    expect(of(compileSong(fixture(tracks(4))), 'detune')).toEqual([]);
    expect(of(compileSong(fixture(tracks(20, held(10, 64, 4)))), 'detune')).toEqual([]);
  });

  it('reports a device pair once', () => {
    const ir = compileSong(fixture(tracks(10, [...held(0, 64, 2), ...held(4, 67, 2)])));
    expect(of(ir, 'detune').length).toBe(1);
  });

  it('leaves out drums', () => {
    const kit = device('kit', 'drum', { fineTune: 30 });
    const ir = compileSong(
      fixture([
        { device: device('pad', 'poly'), cells: held(0, 60, 8) },
        { device: kit, cells: [[0, 0, { note: 60 }]] },
      ]),
    );
    expect(of(ir, 'detune')).toEqual([]);
  });
});

describe('chord clashes and notes outside the key', () => {
  const chords = (...markers: [number, string][]) => (p: Project) => (p.patterns[0].chords = markers.map(([line, symbol]) => ({ line, symbol })));
  const one = (cells: [number, number, Cell][], patch: (p: Project) => void, columns = 1) =>
    compileSong(fixture([{ device: device('lead', 'poly', { maxVoices: 4 }), columns, cells }], patch));

  it('flags a semitone or a tritone against a chord tone on a strong beat', () => {
    const semitone = of(one([[0, 0, { note: 61 }]], chords([0, 'C'])), 'chordClash');
    expect(semitone.length).toBe(1);
    expect(semitone[0]).toMatchObject({ severity: 'info', category: 'music', source: { line: 0 } });
    expect(semitone[0].message).toContain('C#4 is a semitone above C and a tritone from G in C');
    const tritone = of(one([[4, 0, { note: 66 }]], chords([0, 'C'])), 'chordClash');
    expect(tritone[0].message).toContain('a tritone from C');
  });

  it('accepts chord tones and ignores weak beats', () => {
    expect(music(one([[0, 0, { note: 64 }]], chords([0, 'C'])))).toEqual([]);
    expect(music(one([[1, 0, { note: 61 }]], chords([0, 'C'])))).toEqual([]);
  });

  it("counts a slash chord's bass as a chord tone", () => {
    expect(music(one([[0, 0, { note: 64 }]], chords([0, 'D/E'])))).toEqual([]);
    expect(of(one([[0, 0, { note: 65 }]], chords([0, 'D/E'])), 'chordClash').length).toBe(1);
  });

  it('flags a note outside the key that no chord explains', () => {
    const key = (p: Project) => (p.key = { root: 0, mode: 'major' });
    const outside = of(one([[0, 0, { note: 66 }]], key), 'outsideKey');
    expect(outside.length).toBe(1);
    expect(outside[0].message).toContain('F#4 (#4 in C major)');
    expect(outside[0].message).toContain('no chord marker explains it');
    expect(music(one([[0, 0, { note: 67 }]], key))).toEqual([]);
    // A D major chord marker explains the F#.
    expect(
      music(
        one([[0, 0, { note: 66 }]], (p) => {
          key(p);
          chords([0, 'D'])(p);
        }),
      ),
    ).toEqual([]);
  });

  it('uses the pattern key over the song key', () => {
    const ir = one([[0, 0, { note: 66 }]], (p) => {
      p.key = { root: 0, mode: 'major' };
      p.patterns[0].key = { root: 7, mode: 'major' };
    });
    expect(music(ir)).toEqual([]);
  });

  it('gives one hint per pattern, track and line', () => {
    // Two clashing notes on one line, and the pattern played twice.
    const ir = one(
      [
        [0, 0, { note: 61 }],
        [0, 1, { note: 66 }],
      ],
      (p) => {
        chords([0, 'C'])(p);
        p.order = [p.patterns[0].id, p.patterns[0].id];
      },
      2,
    );
    const found = of(ir, 'chordClash');
    expect(found.length).toBe(1);
    expect(found[0].message).toContain('C#4');
    expect(found[0].message).toContain('F#4');
  });

  it('gives no musical hints without a key or chord markers', () => {
    const ir = one(
      [
        [0, 0, { note: 60 }],
        [0, 1, { note: 61 }],
        [0, 2, { note: 66 }],
      ],
      () => {},
      3,
    );
    expect(of(ir, 'chordClash')).toEqual([]);
    expect(of(ir, 'outsideKey')).toEqual([]);
  });

  it('ignores drums and silent notes', () => {
    const kit = device('kit', 'drum');
    const ir = compileSong(
      fixture(
        [
          { device: kit, cells: [[0, 0, { note: 61 }]] },
          { device: device('quiet', 'mono'), cells: [[0, 0, { note: 61, volume: 0 }]] },
        ],
        chords([0, 'C']),
      ),
    );
    expect(music(ir)).toEqual([]);
  });
});

describe('register crowding', () => {
  it('notes two devices held within a whole tone for a beat or more', () => {
    const ir = compileSong(
      fixture([
        { device: device('pad', 'poly'), cells: held(0, 60, 8) },
        { device: device('lead', 'mono'), cells: held(0, 62, 8) },
      ]),
    );
    const found = of(ir, 'registerCrowding');
    expect(found.length).toBe(1);
    expect(found[0]).toMatchObject({ severity: 'info', category: 'music', source: { line: 0 } });
    expect(found[0].message).toContain('"pad" (track 1) and "lead" (track 2)');
    expect(found[0].message).toContain('8 lines (2 beats)');
  });

  it('stays quiet for wider intervals, short overlaps and the same device', () => {
    const pair = (a: [number, number, Cell][], b: [number, number, Cell][], same = false) => {
      const pad = device('pad', 'poly');
      return of(compileSong(fixture([{ device: pad, cells: a }, { device: same ? pad : device('lead', 'mono'), cells: b }])), 'registerCrowding');
    };
    expect(pair(held(0, 60, 8), held(0, 63, 8))).toEqual([]);
    expect(pair(held(0, 60, 8), held(0, 62, 3))).toEqual([]);
    expect(pair(held(0, 60, 8), held(0, 61, 8), true)).toEqual([]);
  });

  it('reports a track pair once per pattern', () => {
    const ir = compileSong(
      fixture([
        { device: device('pad', 'poly'), cells: held(0, 60, 15) },
        { device: device('lead', 'mono'), cells: [...held(0, 61, 4), ...held(8, 62, 4)] },
      ]),
    );
    expect(of(ir, 'registerCrowding').length).toBe(1);
  });

  it("counts the octaves an arpeggiator spans", () => {
    const arp = device('arp', 'arp', { arp: { rate: 3, direction: 'up', octaves: 2 } });
    const ir = compileSong(
      fixture([
        { device: arp, cells: held(0, 48, 8) },
        { device: device('lead', 'mono'), cells: held(0, 61, 8) },
      ]),
    );
    expect(of(ir, 'registerCrowding').length).toBe(1);
  });
});

describe('the demo song', () => {
  it('has no aliasing and no detune, and its musical hints are only hints', () => {
    const ir = compileSong(demoProject());
    expect(of(ir, 'aliasing')).toEqual([]);
    expect(of(ir, 'detune')).toEqual([]);
    for (const d of music(ir)) expect(d.severity).toBe('info');
    expect(ir.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
  });
});
