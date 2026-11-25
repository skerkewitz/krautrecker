import { COUNTER_RATES, DSP_RATE } from './tables';

/**
 * The S-DSP noise generator and pitch modulation, following blargg's snes_spc (SPC_DSP.cpp) and
 * Anomie's S-DSP notes.
 *
 * Noise is one 15-bit linear feedback shift register for the whole chip. It steps whenever the
 * shared rate counter fires for the noise clock (FLG bits 0-4), using the same rate table as the
 * envelopes, so clock 0 never steps and clock 31 steps every sample (32 kHz). A voice with its NON
 * bit set outputs the register instead of its interpolated sample, still through its envelope and
 * volume. The voice keeps decoding its BRR sample underneath, so a one-shot sample that ends
 * still silences a noise voice.
 */

/** Value of the shift register after reset. */
export const NOISE_INITIAL = 0x4000;

/** One step of the shift register: the new bit 14 is bit 0 xor bit 1. */
export function noiseStep(lfsr: number): number {
  const feedback = (lfsr << 13) ^ (lfsr << 14);
  return (feedback & 0x4000) ^ (lfsr >> 1);
}

/** The voice output of a noise voice before the envelope: the register doubled, as a signed 16-bit value. */
export function noiseSample(lfsr: number): number {
  return (lfsr << 17) >> 16;
}

/** Steps per second of the noise generator at a noise clock (0..31); clock 0 never steps. */
export function noiseFrequency(clock: number): number {
  const c = Math.max(0, Math.min(31, Math.round(clock)));
  return c === 0 ? 0 : DSP_RATE / COUNTER_RATES[c];
}

/**
 * Pitch modulation (PMON): the pitch step of voice n is scaled by voice n-1's output after its
 * envelope but before its volume, so a silent (volume 0) modulator still modulates. The output
 * range -32768..32767 scales the pitch by 0..about 2.
 */
export function modulatedPitch(pitch: number, prevOutput: number): number {
  return pitch + (((prevOutput >> 5) * pitch) >> 10);
}
