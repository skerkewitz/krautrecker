import { engine } from '../audio/engine';
import { buildSample } from '../brr/sampleBuild';
import { previewKeyOn } from '../compiler/preview';
import { currentPattern, store } from './store';

/** Transport and audition actions shared by toolbar, keyboard and MIDI. */

export function syncEngine(): void {
  const s = store.getState();
  engine.setSamples(s.project.samples.map((x) => buildSample(x)));
  if (s.ui.playing) engine.setIR(s.ui.playMode === 'pattern' ? store.patternIR(s.ui.currentPatternId) : store.songIR());
}

export async function playSong(fromTick = 0): Promise<void> {
  syncEngine();
  const s = store.getState();
  store.setUi({ playing: true, playMode: 'song', playTick: fromTick });
  await engine.play(store.songIR(), fromTick, 0, s.ui.loop);
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

/** The device a live note should play: the cursor track's device, else the selected device. */
export function auditionDeviceId(): string | null {
  const s = store.getState();
  const pat = currentPattern(s);
  return pat?.tracks[s.ui.cursor.track]?.deviceId ?? s.ui.selectedDeviceId;
}

export function auditionOn(key: string, note: number, velocity = 127, deviceId = auditionDeviceId()): void {
  if (!deviceId) return;
  syncEngine();
  const k = previewKeyOn(store.getState().project, deviceId, note, velocity);
  if (k) void engine.previewOn(key, k);
}

export function auditionOff(key: string): void {
  engine.previewOff(key);
}
