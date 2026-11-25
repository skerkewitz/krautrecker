import type { IR, KeyOnData } from '../compiler/ir';
import type { DspSample } from './sdsp';

/** Messages from the main thread to the DSP worklet. */
export type ToWorklet =
  | { type: 'samples'; samples: DspSample[] }
  | { type: 'ir'; ir: IR }
  | { type: 'play'; from: number; loopStart: number; loop: boolean }
  | { type: 'stop' }
  /** Auditioning: a separate 8-voice DSP for live play and note entry, mixed on top. */
  | { type: 'previewOn'; voice: number; keyOn: KeyOnData }
  | { type: 'previewOff'; voice: number };

/** Messages from the DSP worklet to the main thread. */
export type FromWorklet = { type: 'position'; tick: number; playing: boolean; levels: number[] };

export const PROCESSOR_NAME = 'krautrecker-sdsp';
