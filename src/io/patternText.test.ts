import { describe, expect, it } from 'vitest';
import { demoProject } from '../model/demoSong';
import { NOTE_CUT, NOTE_OFF, type Cell } from '../model/types';
import { blockToText, cellToText, patternBlock, patternToText, patternWithBlock, PatternTextError, textToBlock, tryTextToBlock, type CellBlock } from './patternText';

/** Every kind of field: notes at both ends of the range, OFF/CUT, all value fields at their limits, one and two effects. */
const CELLS: (Cell | null)[] = [
  null,
  { note: 60 },
  { note: 0 },
  { note: 127 },
  { note: 61, volume: 0x7f, pan: 63, delay: 15 },
  { note: NOTE_OFF },
  { note: NOTE_CUT, delay: 3 },
  { volume: 0 },
  { pan: -64 },
  { pan: 0 },
  { delay: 0 },
  { fx: [{ type: 'porta', value: 0x20 }] },
  { fx: [null, { type: 'volSlide', value: 0x0f }] },
  { note: 40, volume: 0x50, fx: [{ type: 'retrig', value: 0x03 }, { type: 'echoWrite', value: 0xff }] },
  { fx: [{ type: 'echoFeedback', value: 0x80 }, { type: 'tempo', value: 0x84 }] },
];

function block(): CellBlock {
  // Three lines, four columns in two tracks: every cell kind appears at least once.
  const cells: (Cell | null)[][] = [];
  for (let l = 0; l < 4; l++) cells.push([0, 1, 2, 3].map((c) => CELLS[(l * 4 + c) % CELLS.length]));
  return { cells, tracks: [3, 1] };
}

describe('pattern text round trip', () => {
  it('writes the editor notation for every field kind', () => {
    expect(cellToText(null)).toBe('... .. .. . ... ...');
    expect(cellToText({ note: 60 })).toBe('C-4 .. .. . ... ...');
    expect(cellToText({ note: 0 })).toBe('C-- .. .. . ... ...');
    expect(cellToText({ note: 127 })).toBe('G-9 .. .. . ... ...');
    expect(cellToText({ note: 61, volume: 0x7f, pan: 63, delay: 15 })).toBe('C#4 7F 7F F ... ...');
    expect(cellToText({ note: NOTE_OFF })).toBe('OFF .. .. . ... ...');
    expect(cellToText({ note: NOTE_CUT })).toBe('^^^ .. .. . ... ...');
    expect(cellToText({ pan: -64, delay: 0 })).toBe('... .. 00 0 ... ...');
    expect(cellToText({ fx: [null, { type: 'volSlide', value: 0x0f }] })).toBe('... .. .. . ... A0F');
    expect(cellToText({ fx: [{ type: 'retrig', value: 3 }, { type: 'echoWrite', value: 0xff }] })).toBe('... .. .. . R03 ZFF');
  });

  it('reads back exactly what it wrote, for every cell kind', () => {
    const b = block();
    const text = blockToText(b, { title: 'test', trackNames: ['Pad', 'Lead'] });
    const back = textToBlock(text);
    expect(back).toEqual(b);
    expect(blockToText(back, { title: 'test', trackNames: ['Pad', 'Lead'] })).toBe(text);
  });

  it('round-trips every pattern of the demo song', () => {
    const project = demoProject();
    for (const pattern of project.patterns) {
      const text = patternToText(pattern, pattern.tracks.map((_, i) => `Track ${i + 1}`));
      const back = textToBlock(text);
      expect(back).toEqual(patternBlock(pattern));
      expect(patternWithBlock(pattern, back)).toEqual(pattern);
    }
  });

  it('normalizes cells without content to empty cells', () => {
    const text = blockToText({ cells: [[{}, { fx: [null, null] }]], tracks: [2] });
    expect(textToBlock(text).cells).toEqual([[null, null]]);
  });

  it('accepts lower case, extra spaces, comments and blank lines', () => {
    const text = [
      '# copied from somewhere',
      'Krautrecker pattern text 1',
      'lines: 2',
      'tracks: 2',
      '',
      '00 |  c#4 7f ..  .  p20 ...  :  ... .. .. . ... ... |',
      '# a comment between lines',
      '01 | off .. .. . ... ... : ^^^ .. 40 2 a0f v23',
    ].join('\r\n');
    expect(textToBlock(text).cells).toEqual([
      [{ note: 61, volume: 0x7f, fx: [{ type: 'porta', value: 0x20 }] }, null],
      [{ note: NOTE_OFF }, { note: NOTE_CUT, pan: 0, delay: 2, fx: [{ type: 'volSlide', value: 0x0f }, { type: 'vibrato', value: 0x23 }] }],
    ]);
  });
});

describe('pattern text errors', () => {
  const header = 'Krautrecker pattern text 1\nlines: 1\ntracks: 1 1\n';
  const error = (text: string): PatternTextError => {
    try {
      textToBlock(text);
    } catch (e) {
      if (e instanceof PatternTextError) return e;
      throw e;
    }
    throw new Error('expected a parse error');
  };

  it('points at the bad field with line and column', () => {
    const e = error(header + '00 | C-4 .. .. . ... ... | X-4 .. .. . ... ... |');
    expect([e.line, e.column]).toEqual([4, 28]);
    expect(e.message).toMatch(/note must be like C-4/);
  });

  it('reports values out of range', () => {
    expect(error(header + '00 | C-4 80 .. . ... ... | ... .. .. . ... ... |').message).toMatch(/volume 80 is out of range/);
    expect(error(header + '00 | C-4 .. 80 . ... ... | ... .. .. . ... ... |').message).toMatch(/pan 80/);
    expect(error(header + '00 | ... .. .. G ... ... | ... .. .. . ... ... |').message).toMatch(/delay must be 1 hex digit/);
    expect(error(header + '00 | ... .. .. . ... ... | ... .. .. . Q10 ... |')).toMatchObject({ line: 4, column: 40 });
    expect(error(header + '00 | ... .. .. . ... ... | ... .. .. . P1G ... |')).toMatchObject({ line: 4, column: 41 });
  });

  it('checks the structure: magic line, headers, tracks, columns, fields and line numbers', () => {
    expect(error('hello').message).toMatch(/not pattern text/);
    expect(error('Krautrecker pattern text 2\n').message).toMatch(/unsupported pattern text version 2/);
    expect(error('Krautrecker pattern text 1\ntracks: 1\n00 | ... .. .. . ... ... |').message).toMatch(/missing header "lines/);
    expect(error('Krautrecker pattern text 1\nlines: 1\ncolumns: 1\n')).toMatchObject({ line: 3, column: 1 });
    expect(error(header + '00 | ... .. .. . ... ... |').message).toMatch(/expected 2 tracks/);
    expect(error(header + '00 | ... .. .. . ... ... : ... .. .. . ... ... | ... .. .. . ... ... |').message).toMatch(/track 1: expected 1 note column/);
    expect(error(header + '00 | ... .. .. . ... | ... .. .. . ... ... |').message).toMatch(/found 5/);
    expect(error(header + '01 | ... .. .. . ... ... | ... .. .. . ... ... |').message).toMatch(/line number 01 out of sequence/);
    expect(error(header)).toMatchObject({ message: expect.stringMatching(/expected 1 data lines, found 0/) });
    expect(error(header + '00 | ... .. .. . ... ... | ... .. .. . ... ... |\n01 | ... .. .. . ... ... | ... .. .. . ... ... |').line).toBe(5);
  });

  it('tryTextToBlock returns null for anything that is not pattern text', () => {
    expect(tryTextToBlock('some text from another app')).toBeNull();
    expect(tryTextToBlock(blockToText(block()))).toEqual(block());
  });
});

describe('importing a whole pattern', () => {
  it('replaces the cells and follows the text in lines and note columns, keeping devices and mix', () => {
    const pattern = demoProject().patterns[2];
    const text = blockToText({ cells: [pattern.tracks.map((_, t) => (t === 4 ? { note: 64 } : null)).flatMap((c, t) => (t === 4 ? [c, { note: 67 }] : [c]))], tracks: pattern.tracks.map((_, t) => (t === 4 ? 2 : 1)) });
    const next = patternWithBlock(pattern, textToBlock(text));
    expect(next.lines).toBe(1);
    expect(next.tracks[4].noteColumns).toBe(2);
    expect(next.tracks[4].cells).toEqual([[{ note: 64 }, { note: 67 }]]);
    expect(next.tracks.map((t) => [t.deviceId, t.volume, t.pan, t.transpose])).toEqual(pattern.tracks.map((t) => [t.deviceId, t.volume, t.pan, t.transpose]));
  });

  it('refuses a text with a different number of tracks', () => {
    const pattern = demoProject().patterns[0];
    expect(() => patternWithBlock(pattern, { cells: [[null]], tracks: [1] })).toThrow(/1 tracks, but pattern "Dämmerung" has 10/);
  });
});
