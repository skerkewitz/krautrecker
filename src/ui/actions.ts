import { engine } from '../audio/engine';
import { buildSample } from '../brr/sampleBuild';
import { liveSetupFor } from '../dsp/live';
import type { Project } from '../model/types';
import { liveDeviceId, store } from './store';

/** Transport and audition actions shared by toolbar, keyboard and MIDI. */

let liveFor: Pick<Project, 'devices' | 'samples' | 'timing' | 'seed' | 'hardware'> | null = null;

export function syncEngine(): void {
  const s = store.getState();
  const p = s.project;
  engine.setSamples(p.samples.map((x) => buildSample(x)));
  // Live play needs devices, samples, timing and echo; resend only when one of them changed.
  if (!liveFor || liveFor.devices !== p.devices || liveFor.samples !== p.samples || liveFor.timing !== p.timing || liveFor.seed !== p.seed || liveFor.hardware !== p.hardware) {
    liveFor = { devices: p.devices, samples: p.samples, timing: p.timing, seed: p.seed, hardware: p.hardware };
    engine.setLive(liveSetupFor(p));
  }
  if (s.ui.playing) engine.setIR(s.ui.playMode === 'pattern' ? store.patternIR(s.ui.currentPatternId) : store.songIR());
}

export async function playSong(fromTick = 0): Promise<void> {
  syncEngine();
  const s = store.getState();
  store.setUi({ playing: true, playMode: 'song', playTick: fromTick });
  // The song loops to its loop point (the order list's loop entry).
  await engine.play(store.songIR(), fromTick, null, s.ui.loop);
}

export async function playPattern(fromLine = 0): Promise<void> {
  syncEngine();
  const s = store.getState();
  const tpl = s.project.timing.ticksPerLine;
  store.setUi({ playing: true, playMode: 'pattern', playTick: fromLine * tpl });
  // Pattern play always loops, as in most trackers.
  await engine.play(store.patternIR(s.ui.currentPatternId), fromLine * tpl, 0, true);
}

/** Plays the song from the cursor line if the pattern is in the song, else loops the pattern from it. */
export async function playFromCursor(): Promise<void> {
  const s = store.getState();
  const ir = store.songIR();
  const line = s.ui.cursor.line;
  let orderIndex = s.ui.orderIndex;
  if (orderIndex < 0 || s.project.order[orderIndex] !== s.ui.currentPatternId) orderIndex = s.project.order.indexOf(s.ui.currentPatternId);
  if (orderIndex < 0) return playPattern(line);
  const info = ir.lines.find((l) => l.orderIndex === orderIndex && l.line === line);
  return playSong(info?.tick ?? 0);
}

export function stop(): void {
  engine.stop();
  store.setUi({ playing: false });
}

export function togglePlay(): void {
  if (store.getState().ui.playing) stop();
  else void playSong(0);
}

/** The device a live note plays: the device selected in the list (see `liveDeviceId`). */
export function auditionDeviceId(): string | null {
  return liveDeviceId(store.getState());
}

/** Live notes by key, so a release goes to the device and note that the press started. */
const held = new Map<string, { deviceId: string; note: number }>();

/**
 * Plays a note live on a device (MIDI, computer keyboard, zone audition). It follows the
 * device's mode: mono, legato, arp and drum behave as in playback.
 */
export function auditionOn(key: string, note: number, velocity = 127, deviceId = auditionDeviceId()): void {
  if (!deviceId) return;
  syncEngine();
  const prev = held.get(key);
  if (prev) engine.liveOff(prev.deviceId, prev.note);
  held.set(key, { deviceId, note });
  void engine.liveOn(deviceId, note, velocity);
}

export function auditionOff(key: string): void {
  const h = held.get(key);
  if (!h) return;
  held.delete(key);
  engine.liveOff(h.deviceId, h.note);
}
