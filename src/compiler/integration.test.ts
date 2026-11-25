import { describe, expect, it } from 'vitest';
import { compileSong } from './compile';
import { device, fixture } from './fixtures';
import type { GlobalEvent, VoiceEvent } from './ir';

/**
 * Where the feature tracks meet: effect memory (track D) feeding global slides (track C) and
 * tremolo (track A), and tremolo working on top of the track mix (track D).
 */

const mainVolumes = (global: GlobalEvent[]) => global.filter((e): e is Extract<GlobalEvent, { type: 'mainVolume' }> => e.type === 'mainVolume');
const volumesIn = (lane: VoiceEvent[], from: number, to: number) =>
  lane.filter((e): e is Extract<VoiceEvent, { type: 'setVolume' }> => e.type === 'setVolume' && e.tick >= from && e.tick < to);

describe('feature tracks together', () => {
  it('H00 continues a main volume slide through effect memory', () => {
    const ir = compileSong(
      fixture([
        {
          device: device('p', 'poly'),
          cells: [
            [0, 0, { fx: [{ type: 'mainVolume', value: 0x40 }] }],
            [1, 0, { fx: [{ type: 'mainVolSlide', value: 0x01 }] }],
            [2, 0, { fx: [{ type: 'mainVolSlide', value: 0x00 }] }],
          ],
        },
      ]),
    );
    const last = mainVolumes(ir.global).at(-1)!;
    // Two lines of 6 ticks, one step down per tick.
    expect(last.volL).toBe(0x40 - 12);
    expect(last.volR).toBe(0x40 - 12);
  });

  it('T00 keeps a tremolo going through effect memory', () => {
    const ir = compileSong(
      fixture([
        {
          device: device('p', 'poly'),
          cells: [
            [0, 0, { note: 60, fx: [{ type: 'tremolo', value: 0x84 }] }],
            [1, 0, { fx: [{ type: 'tremolo', value: 0x00 }] }],
            [2, 0, {}],
          ],
        },
      ]),
    );
    const lane = ir.voices[0];
    expect(volumesIn(lane, 6, 12).length).toBeGreaterThan(0);
    // Line 2 has no tremolo: the volume returns to full and then stays.
    const line2 = volumesIn(lane, 12, 18);
    expect(line2.length).toBeLessThanOrEqual(1);
  });

  it('tremolo dips the volume after the track volume is applied', () => {
    const withTrack = (trackVolume: number) =>
      compileSong(
        fixture(
          [{ device: device('p', 'poly', { volume: 127, tremolo: { depth: 40, rate: 8, delay: 0 } }), cells: [[0, 0, { note: 60 }]] }],
          (p) => (p.patterns[0].tracks[0].volume = trackVolume),
        ),
      );
    const full = withTrack(127).voices[0];
    const half = withTrack(64).voices[0];
    const minFull = Math.min(...volumesIn(full, 0, 96).map((e) => e.volL));
    const minHalf = Math.min(...volumesIn(half, 0, 96).map((e) => e.volL));
    // Tremolo scales with the note's volume, so the quieter track dips proportionally less.
    expect(minFull).toBeLessThan(127);
    expect(minHalf).toBeLessThan(64);
    expect(127 - minFull).toBeGreaterThan(64 - minHalf);
  });
});
