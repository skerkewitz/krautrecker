import type { Effect, EffectType, HardwareSettings, Timing } from '../model/types';
import type { GlobalEvent } from './ir';

/**
 * Global effects: tempo F, mainVolume W, mainVolSlide H, echoVolume E, echoVolSlide Y,
 * echoFeedback B and echoWrite Z. They act on the whole song and persist until changed.
 *
 * They are resolved in two steps. While stage 2 runs a track, `collectGlobalFx` records every
 * global effect at the start of its line, whether or not a note is sounding. After all tracks ran,
 * `resolveGlobalFx` replays the records of all tracks in tick order and emits global IR events.
 * The second step cannot run per track: a slide on track 2 starts from the volume that track 1
 * set earlier, and stage 2 processes one track over the whole song before the next.
 */

/** A global effect as written in a cell, at the first tick of its line. */
export interface GlobalFxCommand {
  tick: number;
  effect: Effect;
}

const GLOBAL_TYPES: ReadonlySet<EffectType> = new Set<EffectType>(['tempo', 'mainVolume', 'mainVolSlide', 'echoVolume', 'echoVolSlide', 'echoFeedback', 'echoWrite']);
const SLIDES: ReadonlySet<EffectType> = new Set<EffectType>(['mainVolSlide', 'echoVolSlide']);

export function isGlobalEffect(type: EffectType): boolean {
  return GLOBAL_TYPES.has(type);
}

/** TrackProcessor hook, called on the first tick of every line with that line's effects per column. */
export function collectGlobalFx(out: GlobalFxCommand[], colFx: readonly (readonly Effect[] | null)[], tick: number): void {
  for (const fx of colFx) {
    if (!fx) continue;
    for (const effect of fx) if (GLOBAL_TYPES.has(effect.type)) out.push({ tick, effect });
  }
}

function s8(v: number): number {
  return ((v & 0xff) << 24) >> 24;
}

/**
 * Sets a volume register's magnitude and keeps its sign. A negative hardware volume inverts that
 * side's phase (the surround trick); a volume effect changes loudness, not the phase setting.
 */
function withMagnitude(current: number, magnitude: number): number {
  const m = Math.max(0, Math.min(current < 0 ? 128 : 127, magnitude));
  return current < 0 ? -m : m;
}

/** One slide step: x = up, y = down (per tick), on the magnitude of the volume. */
function slide(current: number, value: number): number {
  return withMagnitude(current, Math.abs(current) + (value >> 4) - (value & 15));
}

interface Action {
  tick: number;
  /** Tick within the line; slides act on every tick of their line. */
  lineTick: number;
  effect: Effect;
}

/**
 * Turns the collected commands into global IR events. An event is emitted only when a value
 * changes. Per-tick slide steps after the first tick of a line are marked `auto`, because a
 * driver computes them itself (they do not count as song data).
 *
 * `commands` must be in collection order (track by track, each in tick order). Same-tick effects
 * then apply in track order, then column order, so the rightmost track wins a conflict.
 */
export function resolveGlobalFx(commands: readonly GlobalFxCommand[], tpl: number, timing: Timing, hardware: HardwareSettings): GlobalEvent[] {
  const actions: Action[] = [];
  for (const c of commands) {
    if (SLIDES.has(c.effect.type)) for (let k = 0; k < tpl; k++) actions.push({ tick: c.tick + k, lineTick: k, effect: c.effect });
    else actions.push({ tick: c.tick, lineTick: 0, effect: c.effect });
  }
  // Array.prototype.sort is stable, so same-tick actions keep track and column order.
  actions.sort((a, b) => a.tick - b.tick);

  const echo = hardware.echo;
  const fir = echo.fir.slice(0, 8);
  const cur = {
    bpm: timing.bpm,
    mainL: hardware.mainVolumeL,
    mainR: hardware.mainVolumeR,
    echoL: echo.volumeL,
    echoR: echo.volumeR,
    feedback: echo.feedback,
    write: echo.writeEnabled !== false,
  };
  const sent = { ...cur };
  const events: GlobalEvent[] = [];

  let i = 0;
  while (i < actions.length) {
    const tick = actions[i].tick;
    // Set by the composer on this tick (not just a later step of a running slide).
    let mainCmd = false;
    let echoCmd = false;
    for (; i < actions.length && actions[i].tick === tick; i++) {
      const { effect, lineTick } = actions[i];
      const v = effect.value & 0xff;
      switch (effect.type) {
        case 'tempo':
          cur.bpm = Math.max(32, v);
          break;
        case 'mainVolume':
          cur.mainL = withMagnitude(cur.mainL, v);
          cur.mainR = withMagnitude(cur.mainR, v);
          mainCmd = true;
          break;
        case 'mainVolSlide':
          cur.mainL = slide(cur.mainL, v);
          cur.mainR = slide(cur.mainR, v);
          if (lineTick === 0) mainCmd = true;
          break;
        case 'echoVolume':
          cur.echoL = withMagnitude(cur.echoL, v);
          cur.echoR = withMagnitude(cur.echoR, v);
          echoCmd = true;
          break;
        case 'echoVolSlide':
          cur.echoL = slide(cur.echoL, v);
          cur.echoR = slide(cur.echoR, v);
          if (lineTick === 0) echoCmd = true;
          break;
        case 'echoFeedback':
          cur.feedback = s8(v);
          echoCmd = true;
          break;
        case 'echoWrite':
          cur.write = v !== 0;
          break;
      }
    }
    if (cur.bpm !== sent.bpm) events.push({ tick, type: 'tempo', bpm: cur.bpm });
    if (cur.mainL !== sent.mainL || cur.mainR !== sent.mainR) {
      const ev: Extract<GlobalEvent, { type: 'mainVolume' }> = { tick, type: 'mainVolume', volL: cur.mainL, volR: cur.mainR };
      if (!mainCmd) ev.auto = true;
      events.push(ev);
    }
    if (cur.echoL !== sent.echoL || cur.echoR !== sent.echoR || cur.feedback !== sent.feedback) {
      const ev: Extract<GlobalEvent, { type: 'echo' }> = { tick, type: 'echo', params: { delay: echo.delay, feedback: cur.feedback, volumeL: cur.echoL, volumeR: cur.echoR, fir: fir.slice() } };
      if (!echoCmd) ev.auto = true;
      events.push(ev);
    }
    if (cur.write !== sent.write) events.push({ tick, type: 'echoWrite', enabled: cur.write });
    Object.assign(sent, cur);
  }
  return events;
}

/** True for global events that per-tick modulation generated (not song data). */
export function isAutoGlobal(e: GlobalEvent): boolean {
  return (e.type === 'mainVolume' || e.type === 'echo') && e.auto === true;
}
