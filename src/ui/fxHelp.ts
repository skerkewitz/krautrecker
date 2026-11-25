import { FX_LETTERS, FX_MEMORY } from '../model/notes';
import type { EffectType } from '../model/types';

/** Name and value meaning of each effect, for the pattern editor's help line. Mirrors `Effect` in the model. */
export const FX_HELP: Record<EffectType, { name: string; value: string }> = {
  slideUp: { name: 'slide up', value: 'xx/16 semitones per line' },
  slideDown: { name: 'slide down', value: 'xx/16 semitones per line' },
  porta: { name: 'portamento', value: 'glide to the note at xx/16 semitones per line' },
  vibrato: { name: 'vibrato', value: 'x = depth in ¼ semitones, y = period in 2-tick steps' },
  tremolo: { name: 'tremolo', value: 'x = depth in 8-volume steps, y = period in 2-tick steps' },
  volSlide: { name: 'volume slide', value: 'x = up, y = down per tick' },
  panSlide: { name: 'pan slide', value: 'x = right, y = left per tick' },
  cut: { name: 'note cut', value: 'release the note after xx ticks' },
  retrig: { name: 'retrigger', value: 'retrigger the note every xx ticks' },
  gain: { name: 'GAIN', value: 'switch the note to this raw GAIN byte' },
  noise: { name: 'noise', value: '00-1F noise at that clock, 20-FF noise off' },
  trackVolume: { name: 'track volume', value: '00-7F, until the pattern ends' },
  trackVolSlide: { name: 'track volume slide', value: 'x = up, y = down per tick' },
  trackPan: { name: 'track pan', value: '00-7F, 40 = centre, until the pattern ends' },
  tempo: { name: 'tempo', value: 'BPM, 20-FF = 32-255' },
  mainVolume: { name: 'main volume', value: '00-7F, both sides' },
  mainVolSlide: { name: 'main volume slide', value: 'x = up, y = down per tick' },
  echoVolume: { name: 'echo volume', value: '00-7F, both sides' },
  echoVolSlide: { name: 'echo volume slide', value: 'x = up, y = down per tick' },
  echoFeedback: { name: 'echo feedback', value: 'signed, 80-FF = negative' },
  echoWrite: { name: 'echo write', value: '00 freezes the echo buffer, else writes' },
};

/** One-line help for an effect: letter, name, value meaning and whether 00 repeats. */
export function fxHelpText(type: EffectType): string {
  const h = FX_HELP[type];
  const memory = FX_MEMORY.has(type) ? (type === 'vibrato' || type === 'tremolo' ? '; 0 keeps that nibble' : '; 00 repeats') : '';
  return `${FX_LETTERS[type]} ${h.name}: ${h.value}${memory}`;
}

/** All effect letters by group, for the help line on an empty effect field. */
export const FX_LETTER_SUMMARY = 'Effect: note U D P V T A L C R G N · track M K X · global F W H E Y B Z';
