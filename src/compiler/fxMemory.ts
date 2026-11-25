import { FX_MEMORY } from '../model/notes';
import type { Effect, EffectType } from '../model/types';

/** Effects whose memory works per nibble: x = 0 keeps the old x, y = 0 keeps the old y. */
const NIBBLE_MEMORY: ReadonlySet<EffectType> = new Set<EffectType>(['vibrato', 'tremolo']);

/**
 * FT2-style effect memory for one track. A value of 00 on an effect in `FX_MEMORY` repeats the
 * last non-zero value of that type in the same note column; vibrato and tremolo remember each
 * nibble separately. The memory lives as long as the track processor, so it carries across lines
 * and patterns in song order, as a sound driver reading the song front to back would see it.
 *
 * Resolving here, before any effect is applied, means every effect implementation sees the value
 * that will actually play and never has to know about memory.
 */
export class FxMemory {
  /** Per note column: effect type -> last non-zero (resolved) value. */
  private last: Map<EffectType, number>[] = [];

  /** Returns the column's effects with remembered values filled in. Never mutates the input. */
  resolve(column: number, effects: Effect[]): Effect[] {
    let mem = this.last[column];
    if (!mem) mem = this.last[column] = new Map();
    return effects.map((fx) => {
      if (!FX_MEMORY.has(fx.type)) return fx;
      const prev = mem.get(fx.type) ?? 0;
      let value = fx.value;
      if (NIBBLE_MEMORY.has(fx.type)) value = (value & 0xf0 || prev & 0xf0) | (value & 0x0f || prev & 0x0f);
      else if (value === 0) value = prev;
      if (value !== 0) mem.set(fx.type, value);
      return value === fx.value ? fx : { type: fx.type, value };
    });
  }
}
