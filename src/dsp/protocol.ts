import type { IR, KeyOnData } from '../compiler/ir';
import type { LiveSetup } from './live';
import type { DspSample } from './sdsp';

/** Messages from the main thread to the DSP worklet. */
export type ToWorklet =
  | { type: 'samples'; samples: DspSample[] }
  | { type: 'ir'; ir: IR }
  | { type: 'play'; from: number; loopStart: number; loop: boolean }
  | { type: 'stop' }
  /** Live play with the device's rules (MIDI, keyboard, zone audition), on its own DSP. */
  | { type: 'liveSetup'; setup: LiveSetup }
  | { type: 'liveOn'; deviceId: string; note: number; velocity: number }
  | { type: 'liveOff'; deviceId: string; note: number }
  | { type: 'liveAllOff' }
  /** Raw sample audition at the root note, outside any device. */
  | { type: 'sampleOn'; keyOn: KeyOnData }
  | { type: 'sampleOff' };

/** Messages from the DSP worklet to the main thread. */
export type FromWorklet = { type: 'position'; tick: number; playing: boolean; levels: number[] };

export const PROCESSOR_NAME = 'krautrecker-sdsp';
