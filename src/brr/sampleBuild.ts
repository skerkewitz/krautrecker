import type { Sample, SampleId } from '../model/types';
import { base64ToInt16 } from '../util/base64';
import { encodeBrr } from './brr';
import { resample } from './resample';
import { highestSignificantFrequency } from './spectrum';

/**
 * A sample as the hardware sees it: BRR data plus what the compiler needs to compute pitch and
 * note length. Built deterministically from a `Sample`; never stored in the project.
 */
export interface BuiltSample {
  sampleId: SampleId;
  brr: Uint8Array;
  /** Block the loop jumps back to, or -1. */
  loopBlock: number;
  /** Encoded length in samples (a multiple of 16). */
  length: number;
  /**
   * The rate at which the encoded data plays at its root note. Usually `targetRate`, but loop
   * alignment can stretch it slightly; the compiler compensates in the pitch register.
   */
  effectiveRate: number;
  /** Human-readable notes about changes the build had to make (loop realignment). */
  notes: string[];
  /**
   * Highest significant frequency in Hz when played at `effectiveRate` (the loop for looping
   * samples), for the aliasing check; 0 for silence. Absent where no PCM was analysed (live play).
   */
  highestFrequency?: number;
}

const cache = new Map<string, BuiltSample>();
const CACHE_LIMIT = 64;

/**
 * Cache key: only the fields that change the BRR data. Root note and fine tune do not, so
 * editing them must not trigger a re-encode. The PCM is identified by length plus a sparse hash,
 * which is enough to tell imported files apart without hashing megabytes on every edit.
 */
function cacheKey(s: Sample): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(s.pcm.length / 512));
  for (let i = 0; i < s.pcm.length; i += step) h = Math.imul(h ^ s.pcm.charCodeAt(i), 0x01000193);
  return [s.id, s.pcm.length, h >>> 0, s.sampleRate, s.targetRate, s.loop.enabled, s.loop.start].join('|');
}

/** Builds (and caches) the BRR form of a sample. Returns the same object while nothing relevant changed. */
export function buildSample(sample: Sample): BuiltSample {
  const key = cacheKey(sample);
  const cached = cache.get(key);
  if (cached) return cached;
  const built = buildSampleUncached(sample);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, built);
  return built;
}

export function buildSampleUncached(sample: Sample): BuiltSample {
  const src = base64ToInt16(sample.pcm);
  const notes: string[] = [];
  const target = Math.max(1000, Math.min(64000, sample.targetRate));
  const loopStart = sample.loop.start;
  const looping = sample.loop.enabled && src.length > 0 && loopStart >= 0 && loopStart < src.length;

  if (!looping) {
    const res = resample(src, sample.sampleRate, target);
    const padded = new Int16Array(Math.max(16, Math.ceil(res.length / 16) * 16));
    padded.set(res);
    const enc = encodeBrr(padded, null);
    const highestFrequency = highestSignificantFrequency(padded, target, false);
    return { sampleId: sample.id, brr: enc.data, loopBlock: -1, length: padded.length, effectiveRate: target, notes, highestFrequency };
  }

  // The hardware can only loop to a block boundary, and the loop end is always a block end.
  // So the loop length must be a multiple of 16 samples: we resample the whole sample by a
  // tiny factor to get there (the compiler compensates the pitch), then pad silence in front
  // so the loop start lands on a block boundary.
  const loopLenSrc = src.length - loopStart;
  const loopLenTarget = (loopLenSrc * target) / sample.sampleRate;
  const loopLen = Math.max(16, Math.round(loopLenTarget / 16) * 16);
  const effectiveRate = (loopLen * sample.sampleRate) / loopLenSrc;
  const outLength = Math.max(loopLen, Math.round((src.length * effectiveRate) / sample.sampleRate));
  const res = resample(src, sample.sampleRate, effectiveRate, outLength);
  const startInRes = outLength - loopLen;
  const pad = (16 - (startInRes % 16)) % 16;
  const pcm = new Int16Array(pad + outLength);
  pcm.set(res, pad);
  const alignedStart = startInRes + pad;
  if (pad > 0) notes.push(`Loop start aligned to a 16-sample block: ${pad} samples of silence added at the start.`);
  if (Math.abs(loopLen - loopLenTarget) > 1e-6) {
    notes.push(
      `Loop length resampled from ${loopLenTarget.toFixed(1)} to ${loopLen} samples (multiple of 16); pitch is compensated.`,
    );
  }
  const enc = encodeBrr(pcm, alignedStart);
  const highestFrequency = highestSignificantFrequency(pcm.subarray(alignedStart), effectiveRate, true);
  return { sampleId: sample.id, brr: enc.data, loopBlock: enc.loopBlock, length: pcm.length, effectiveRate, notes, highestFrequency };
}
