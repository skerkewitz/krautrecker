import { clamp } from '../model/notes';
import type { Cell, Effect, Track } from '../model/types';

/**
 * The mix of one track: its current volume and pan, and the transpose of the current pattern.
 *
 * Each pattern starts from its own static track settings (`Track.volume`, `pan`, `transpose`).
 * The track effects M (volume), K (volume slide) and X (pan) then change the current volume and
 * pan until the pattern ends; the next pattern starts again from its own settings. That keeps a
 * pattern sounding the same wherever it sits in the order list and when it is played alone, and
 * the values in the track header are what the track really starts with. A fade that spans two
 * patterns therefore sets the next pattern's track volume (or writes an M on its first line).
 *
 * Track effects act on the track itself, so they work on lines without a sounding note, and the
 * note emitter applies the current mix to every note of the track on every tick.
 */
export class TrackMix {
  /** Current track volume 0..127, multiplied into every note's volume. */
  volume = 127;
  /** Current track pan -64..63, added to every note's pan. */
  pan = 0;
  /** Semitones added to every note entered in the current pattern. */
  transpose = 0;

  /** Pattern start: the pattern's static settings replace what M, K and X left. True if the mix changed. */
  enterPattern(track: Track | undefined): boolean {
    const volume = clamp(Math.round(track?.volume ?? 127), 0, 127);
    const pan = clamp(Math.round(track?.pan ?? 0), -64, 63);
    this.transpose = Math.round(track?.transpose ?? 0);
    const changed = volume !== this.volume || pan !== this.pan;
    this.volume = volume;
    this.pan = pan;
    return changed;
  }

  /** The cell as the device should see it: its note transposed, before zone selection. */
  transposeCell(cell: Cell): Cell {
    if (this.transpose === 0 || typeof cell.note !== 'number') return cell;
    return { ...cell, note: clamp(cell.note + this.transpose, 0, 127) };
  }

  /**
   * One tick of the current line's track effects, from every note column in column order. Set
   * commands (M, X) fire on the line's first tick; the slide K runs on every tick, like the note
   * volume slide. Returns true when a set command changed the mix, so the caller can mark the
   * resulting volume changes as written by the composer rather than generated.
   */
  tick(colFx: readonly (readonly Effect[] | null)[], lineTick: number): boolean {
    let set = false;
    for (const fxs of colFx) {
      if (!fxs) continue;
      for (const fx of fxs) {
        const v = fx.value;
        switch (fx.type) {
          case 'trackVolume':
            if (lineTick === 0) {
              const volume = Math.min(127, v);
              set ||= volume !== this.volume;
              this.volume = volume;
            }
            break;
          case 'trackPan':
            if (lineTick === 0) {
              const pan = Math.min(127, v) - 64;
              set ||= pan !== this.pan;
              this.pan = pan;
            }
            break;
          case 'trackVolSlide':
            this.volume = clamp(this.volume + (v >> 4) - (v & 15), 0, 127);
            break;
        }
      }
    }
    return set;
  }
}
