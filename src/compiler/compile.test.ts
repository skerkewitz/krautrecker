import { describe, expect, it } from 'vitest';
import { demoProject } from '../model/demo';
import { NOTE_OFF, type Project } from '../model/types';
import { mulberry32 } from '../util/prng';
import { compileSong } from './compile';
import { device, fixture, TEST_SAMPLE_ID } from './fixtures';
import type { IR, KeyOnEvent } from './ir';

function keyOns(ir: IR): { voice: number; tick: number; note: number; pitch: number }[] {
  const out: { voice: number; tick: number; note: number; pitch: number }[] = [];
  ir.voices.forEach((lane, voice) => {
    for (const e of lane) if (e.type === 'keyOn') out.push({ voice, tick: e.tick, note: e.note, pitch: e.pitch });
  });
  return out.sort((a, b) => a.tick - b.tick || a.voice - b.voice);
}

/** Compact, readable IR dump for golden snapshots. */
function dump(ir: IR): string[] {
  const rows: string[] = [];
  ir.voices.forEach((lane, v) => {
    for (const e of lane) {
      const src = `@${e.source.track}:${e.source.line}:${e.source.column}`;
      switch (e.type) {
        case 'keyOn':
          rows.push(`v${v} t${e.tick} keyOn n${e.note} p${e.pitch.toString(16)} vol${e.volL}/${e.volR}${e.stolen ? ' STOLEN' : ''}${e.clamped ? ' CLAMPED' : ''} ${src}`);
          break;
        case 'setPitch':
          rows.push(`v${v} t${e.tick} pitch p${e.pitch.toString(16)}${e.auto ? ' auto' : ''} ${src}`);
          break;
        case 'setVolume':
          rows.push(`v${v} t${e.tick} vol ${e.volL}/${e.volR}${e.auto ? ' auto' : ''} ${src}`);
          break;
        default:
          rows.push(`v${v} t${e.tick} ${e.type} ${src}`);
      }
    }
  });
  for (const d of ir.diagnostics) rows.push(`diag ${d.kind}: ${d.message}`);
  return rows;
}

describe('device modes', () => {
  it('poly: a chord takes one voice per note', () => {
    const ir = compileSong(fixture([{ device: device('pad', 'poly', { maxVoices: 8 }), columns: 3, cells: [[0, 0, { note: 60 }], [0, 1, { note: 64 }], [0, 2, { note: 67 }]] }]));
    expect(keyOns(ir)).toEqual([
      { voice: 0, tick: 0, note: 60, pitch: 0x1000 },
      { voice: 1, tick: 0, note: 64, pitch: Math.round(0x1000 * 2 ** (4 / 12)) },
      { voice: 2, tick: 0, note: 67, pitch: Math.round(0x1000 * 2 ** (7 / 12)) },
    ]);
    expect(dump(ir)).toMatchSnapshot();
  });

  it('poly: a new note in the same column reuses that column voice', () => {
    const ir = compileSong(fixture([{ device: device('pad', 'poly'), cells: [[0, 0, { note: 60 }], [4, 0, { note: 62 }], [8, 0, { note: NOTE_OFF }]] }]));
    expect(keyOns(ir).map((k) => k.voice)).toEqual([0, 0]);
    expect(ir.voices[0].map((e) => e.type)).toEqual(['keyOn', 'keyOn', 'keyOff']);
    expect(ir.voices[0][2].tick).toBe(48);
  });

  it('mono: each note retriggers the same voice', () => {
    const ir = compileSong(fixture([{ device: device('m', 'mono'), columns: 2, cells: [[0, 0, { note: 60 }], [2, 1, { note: 64 }], [4, 0, { note: 67 }]] }]));
    expect(keyOns(ir).map((k) => [k.voice, k.tick, k.note])).toEqual([
      [0, 0, 60],
      [0, 12, 64],
      [0, 24, 67],
    ]);
  });

  it('legato: overlapping notes change pitch without a new key-on', () => {
    const ir = compileSong(fixture([{ device: device('l', 'legato'), cells: [[0, 0, { note: 60 }], [2, 0, { note: 72 }], [4, 0, { note: NOTE_OFF }]] }]));
    const lane = ir.voices[0];
    expect(lane.map((e) => e.type)).toEqual(['keyOn', 'setPitch', 'keyOff']);
    expect(lane[1]).toMatchObject({ tick: 12, pitch: 0x2000 });
    expect(lane[1].auto).toBeUndefined();
  });

  it('legato with portamento glides over the given ticks', () => {
    const ir = compileSong(fixture([{ device: device('l', 'legato', { legatoPortamento: 4 }), cells: [[0, 0, { note: 60 }], [1, 0, { note: 72 }]] }]));
    const pitches = ir.voices[0].filter((e) => e.type === 'setPitch').map((e) => (e as { pitch: number }).pitch);
    expect(pitches.length).toBe(4);
    expect(pitches[pitches.length - 1]).toBe(0x2000);
    for (let i = 1; i < pitches.length; i++) expect(pitches[i]).toBeGreaterThan(pitches[i - 1]);
  });
});

describe('arpeggiator', () => {
  const chord = (direction: string, octaves = 1, seed = 1): IR =>
    compileSong(
      fixture(
        [
          {
            device: device('a', 'arp', { arp: { rate: 2, direction: direction as never, octaves } }),
            columns: 3,
            cells: [[0, 0, { note: 64 }], [0, 1, { note: 60 }], [0, 2, { note: 67 }], [2, 0, { note: NOTE_OFF }], [2, 1, { note: NOTE_OFF }], [2, 2, { note: NOTE_OFF }]],
          },
        ],
        (p) => (p.seed = seed),
      ),
    );

  it('plays held notes as steps on one voice every `rate` ticks', () => {
    const ks = keyOns(chord('up'));
    expect(ks.every((k) => k.voice === 0)).toBe(true);
    expect(ks.map((k) => k.tick)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(ks.map((k) => k.note)).toEqual([60, 64, 67, 60, 64, 67]);
  });

  it('supports down, upDown and asPlayed', () => {
    expect(keyOns(chord('down')).map((k) => k.note)).toEqual([67, 64, 60, 67, 64, 60]);
    expect(keyOns(chord('upDown')).map((k) => k.note)).toEqual([60, 64, 67, 64, 60, 64]);
    // asPlayed follows entry order; within one line that is column order.
    expect(keyOns(chord('asPlayed')).map((k) => k.note)).toEqual([64, 60, 67, 64, 60, 67]);
  });

  it('spans several octaves', () => {
    expect(keyOns(chord('up', 2)).map((k) => k.note)).toEqual([60, 64, 67, 72, 76, 79]);
  });

  it('random is seeded: same seed, same notes', () => {
    const a = keyOns(chord('random', 2, 7)).map((k) => k.note);
    const b = keyOns(chord('random', 2, 7)).map((k) => k.note);
    expect(a).toEqual(b);
    const others = [1, 2, 3, 4, 5].map((s) => keyOns(chord('random', 2, s)).map((k) => k.note).join());
    expect(new Set([...others, a.join()]).size).toBeGreaterThan(1);
  });

  it('releases when all keys are up', () => {
    const lane = chord('up').voices[0];
    expect(lane[lane.length - 1]).toMatchObject({ type: 'keyOff', tick: 12 });
  });

  it('golden', () => {
    expect(dump(chord('upDown', 2))).toMatchSnapshot();
  });
});

describe('drums and choke groups', () => {
  const kit = device('kit', 'drum', {
    maxVoices: 4,
    zones: [
      { sampleId: TEST_SAMPLE_ID, keyRange: [36, 36], fixedPitch: 60, volume: 127, pan: 0 },
      { sampleId: TEST_SAMPLE_ID, keyRange: [42, 42], fixedPitch: 72, volume: 127, pan: 0, chokeGroup: 1 },
      { sampleId: TEST_SAMPLE_ID, keyRange: [46, 46], fixedPitch: 67, volume: 127, pan: 0, chokeGroup: 1 },
    ],
  });

  it('plays zones at their fixed pitch regardless of key', () => {
    const ir = compileSong(fixture([{ device: kit, cells: [[0, 0, { note: 42 }]] }]));
    expect(keyOns(ir)[0].pitch).toBe(0x2000);
  });

  it('a note in a choke group cuts the running note of that group by taking its voice', () => {
    const ir = compileSong(fixture([{ device: kit, columns: 2, cells: [[0, 0, { note: 36 }], [0, 1, { note: 46 }], [2, 1, { note: 42 }]] }]));
    const ks = keyOns(ir);
    const open = ks.find((k) => k.tick === 0 && k.pitch !== 0x1000)!;
    const closed = ks.find((k) => k.tick === 12)!;
    expect(closed.voice).toBe(open.voice);
    // The kick keeps its own voice and is not choked.
    expect(ks.find((k) => k.pitch === 0x1000)!.voice).not.toBe(closed.voice);
    expect(ir.diagnostics.filter((d) => d.kind === 'voiceStolen')).toEqual([]);
  });

  it('notes outside the choke group ring on separate voices', () => {
    const ir = compileSong(fixture([{ device: kit, cells: [[0, 0, { note: 36 }], [1, 0, { note: 36 }]] }]));
    const ks = keyOns(ir);
    expect(ks.map((k) => k.voice)).toEqual([0, 1]);
  });

  it('golden', () => {
    const ir = compileSong(fixture([{ device: kit, columns: 2, cells: [[0, 0, { note: 36 }], [0, 1, { note: 46 }], [2, 1, { note: 42 }], [4, 0, { note: 36 }]] }]));
    expect(dump(ir)).toMatchSnapshot();
  });
});

describe('voice allocation', () => {
  const nineNotes = (count: number) => Array.from({ length: count }, (_, c) => [0, c, { note: 60 + c }] as [number, number, { note: number }]);

  it('steals the oldest voice when all 8 are busy', () => {
    const ir = compileSong(
      fixture([
        { device: device('a', 'poly', { maxVoices: 8 }), columns: 8, cells: nineNotes(8) },
        { device: device('b', 'poly', { maxVoices: 8 }), cells: [[4, 0, { note: 72 }]] },
      ]),
    );
    const stolen = ir.diagnostics.filter((d) => d.kind === 'voiceStolen');
    expect(stolen.length).toBe(1);
    expect(stolen[0].voice).toBe(0);
    expect((ir.voices[0][0] as KeyOnEvent).stolen).toBe(true);
    expect(ir.voiceUsage[4]).toEqual({ used: 8, demand: 9 });
  });

  it('never steals from a higher-priority device; the note is dropped instead', () => {
    const ir = compileSong(
      fixture([
        { device: device('hi', 'poly', { maxVoices: 8, priority: 200 }), columns: 8, cells: nineNotes(8) },
        { device: device('lo', 'poly', { priority: 10 }), cells: [[4, 0, { note: 72 }]] },
      ]),
    );
    expect(ir.diagnostics.filter((d) => d.kind === 'noteDropped').length).toBe(1);
    expect(keyOns(ir).length).toBe(8);
  });

  it('steals the lowest-priority voice first', () => {
    const ir = compileSong(
      fixture([
        { device: device('hi', 'poly', { maxVoices: 8, priority: 200 }), columns: 7, cells: nineNotes(7) },
        { device: device('lo', 'poly', { priority: 10 }), cells: [[0, 0, { note: 48 }]] },
        { device: device('mid', 'poly', { priority: 100 }), cells: [[4, 0, { note: 72 }]] },
      ]),
    );
    const late = keyOns(ir).find((k) => k.tick === 24)!;
    expect(late.voice).toBe(7);
  });

  it('a poly device at maxVoices steals its own oldest voice', () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly', { maxVoices: 2 }), columns: 3, cells: [[0, 0, { note: 60 }], [1, 1, { note: 64 }], [2, 2, { note: 67 }]] }]));
    const ks = keyOns(ir);
    expect(ks.map((k) => k.voice)).toEqual([0, 1, 0]);
    expect(ir.diagnostics.find((d) => d.kind === 'voiceStolen')?.message).toContain('device voice limit');
  });

  it('keeps reserved SFX voices empty', () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly', { maxVoices: 8 }), columns: 8, cells: nineNotes(8) }], (p) => (p.hardware.reservedSfxVoices = 2)));
    expect(ir.reservedVoices).toEqual([6, 7]);
    expect(ir.voices[6]).toEqual([]);
    expect(ir.voices[7]).toEqual([]);
    expect(ir.diagnostics.filter((d) => d.kind === 'voiceStolen').length).toBe(2);
  });

  it('a voice is free again shortly after key-off', () => {
    const ir = compileSong(
      fixture([
        { device: device('a', 'poly', { maxVoices: 8 }), columns: 1, cells: [[0, 0, { note: 60 }], [2, 0, { note: NOTE_OFF }]] },
        { device: device('b', 'poly'), cells: [[4, 0, { note: 62 }]] },
      ]),
    );
    expect(keyOns(ir).map((k) => k.voice)).toEqual([0, 0]);
  });
});

describe('pitch and zones', () => {
  it('clamps pitch above the 14-bit register and warns', () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly'), cells: [[0, 0, { note: 60 + 36 }]] }]));
    expect(keyOns(ir)[0].pitch).toBe(0x3fff);
    expect((ir.voices[0][0] as KeyOnEvent).clamped).toBe(true);
    expect(ir.diagnostics.some((d) => d.kind === 'pitchClamped')).toBe(true);
  });

  it('first matching zone wins when ranges overlap', () => {
    const p = fixture([{ device: device('p', 'poly'), cells: [[0, 0, { note: 60 }]] }], (proj) => {
      proj.samples.push({ ...proj.samples[0], id: 'smp_other', rootNote: 48 });
      proj.devices[0].zones = [
        { sampleId: 'smp_other', keyRange: [50, 70], volume: 127, pan: 0 },
        { sampleId: TEST_SAMPLE_ID, keyRange: [55, 65], volume: 127, pan: 0 },
      ];
    });
    const k = compileSong(p).voices[0][0] as KeyOnEvent;
    expect(k.sampleSlot).toBe(1);
    expect(k.pitch).toBe(0x2000);
  });

  it('falls back to the zone with the nearest root note and warns', () => {
    const p = fixture([{ device: device('p', 'poly'), cells: [[0, 0, { note: 40 }]] }], (proj) => {
      proj.samples.push({ ...proj.samples[0], id: 'smp_low', rootNote: 36 });
      proj.devices[0].zones = [
        { sampleId: TEST_SAMPLE_ID, keyRange: [60, 70], volume: 127, pan: 0 },
        { sampleId: 'smp_low', keyRange: [20, 30], volume: 127, pan: 0 },
      ];
    });
    const ir = compileSong(p);
    expect((ir.voices[0][0] as KeyOnEvent).sampleSlot).toBe(1);
    expect(ir.diagnostics.some((d) => d.kind === 'noZone')).toBe(true);
  });
});

describe('effects', () => {
  it('slideUp moves the pitch value/16 semitones over one line', () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly'), cells: [[0, 0, { note: 60 }], [1, 0, { fx: { type: 'slideUp', value: 0x10 } }]] }]));
    const last = ir.voices[0].filter((e) => e.type === 'setPitch').pop() as { pitch: number; auto?: boolean };
    expect(last.pitch).toBe(Math.round(0x1000 * 2 ** (1 / 12)));
    expect(last.auto).toBe(true);
  });

  it('cut releases after n ticks', () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly'), cells: [[0, 0, { note: 60, fx: { type: 'cut', value: 3 } }]] }]));
    expect(ir.voices[0].find((e) => e.type === 'keyOff')?.tick).toBe(3);
  });

  it('retrig re-keys the note on the same voice', () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly'), cells: [[0, 0, { note: 60, fx: { type: 'retrig', value: 2 } }]] }]));
    expect(keyOns(ir).map((k) => [k.voice, k.tick])).toEqual([
      [0, 0],
      [0, 2],
      [0, 4],
    ]);
  });

  it('note delay shifts the key-on by ticks', () => {
    const ir = compileSong(fixture([{ device: device('p', 'poly'), cells: [[1, 0, { note: 60, delay: 4 }]] }]));
    expect(keyOns(ir)[0].tick).toBe(10);
  });
});

/** Recursively rebuilds an object with its keys in a shuffled order. */
function shuffleKeys(value: unknown, rnd: () => number): unknown {
  if (Array.isArray(value)) return value.map((v) => shuffleKeys(v, rnd));
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = shuffleKeys((value as Record<string, unknown>)[k], rnd);
    return out;
  }
  return value;
}

describe('determinism', () => {
  it('compiling the same project twice gives identical IR', () => {
    const a = JSON.stringify(compileSong(demoProject()));
    const b = JSON.stringify(compileSong(demoProject()));
    expect(a).toBe(b);
  });

  it('object key order does not matter', () => {
    const project = demoProject();
    const reference = compileSong(project);
    const shuffled = shuffleKeys(JSON.parse(JSON.stringify(project)), mulberry32(42)) as Project;
    const ir = compileSong(shuffled);
    expect(JSON.stringify(ir)).toBe(JSON.stringify(reference));
  });

  it('the demo song compiles without voice problems', () => {
    const ir = compileSong(demoProject());
    expect(ir.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(ir.aram.total).toBeLessThan(ir.aram.capacity);
  });
});

