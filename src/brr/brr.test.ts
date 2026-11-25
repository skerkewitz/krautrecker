import { describe, expect, it } from 'vitest';
import type { Sample } from '../model/types';
import { int16ToBase64 } from '../util/base64';
import { BRR_BLOCK_BYTES, decodeBrr, decodeSample, encodeBrr, parseHeader } from './brr';
import { buildSampleUncached } from './sampleBuild';

function sine(n: number, period: number, amp = 20000): Int16Array {
  return Int16Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * i) / period)));
}

function rmsError(a: Int16Array, b: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / a.length);
}

describe('BRR decoder (hardware arithmetic)', () => {
  it('decodes shift/filter 0 nibbles exactly as the S-DSP does', () => {
    expect(decodeSample(1, 12, 0, 0, 0)).toBe(4096);
    expect(decodeSample(7, 12, 0, 0, 0)).toBe(28672);
    expect(decodeSample(-8, 12, 0, 0, 0)).toBe(-32768);
    expect(decodeSample(-1, 0, 0, 0, 0)).toBe(-2);
  });

  it('collapses invalid shifts 13-15 to 0 or -2048 (before doubling)', () => {
    expect(decodeSample(-1, 13, 0, 0, 0)).toBe(-4096);
    expect(decodeSample(5, 15, 0, 0, 0)).toBe(0);
  });

  it('applies the prediction filters with the hardware coefficients', () => {
    // Filter 1: p1 * 15/32 on the stored (doubled) value.
    expect(decodeSample(0, 0, 1, 1000, 0)).toBe(936);
    // Filter 2: p1 * 61/32 - p2 * 15/16 (half scale), doubled.
    expect(decodeSample(0, 0, 2, 1000, 500)).toBe(2 * (1000 - 250 + (250 >> 4) + ((1000 * -3) >> 6)));
    // Filter 3: p1 * 115/64 - p2 * 13/16 (half scale), doubled.
    expect(decodeSample(0, 0, 3, 1000, 500)).toBe(2 * (1000 - 250 + ((1000 * -13) >> 7) + ((250 * 3) >> 4)));
  });

  it('wraps to 16 bits after doubling, like the hardware', () => {
    // 0x7FFF clamped, then doubled with 16-bit wrap gives -2.
    expect(decodeSample(7, 12, 2, 32766, 0)).toBe(-2);
  });

  it('decodes a known reference block', () => {
    // Shift 12, filter 0, end flag. Nibbles 1, -1, 7, -8, then zeros.
    const block = new Uint8Array([0xc1, 0x1f, 0x78, 0, 0, 0, 0, 0, 0]);
    const out = decodeBrr(block);
    expect(Array.from(out.slice(0, 5))).toEqual([4096, -4096, 28672, -32768, 0]);
    expect(parseHeader(0xc1)).toEqual({ shift: 12, filter: 0, loop: false, end: true });
  });
});

describe('BRR encoder', () => {
  it('round-trips a sine within a small error', () => {
    const pcm = sine(1024, 37.3);
    const enc = encodeBrr(pcm, null);
    expect(enc.data.length).toBe((1024 / 16) * BRR_BLOCK_BYTES);
    const dec = decodeBrr(enc.data);
    // 4-bit ADPCM on a smooth signal: well under 1% of full scale.
    expect(rmsError(pcm, dec)).toBeLessThan(200);
  });

  it('round-trips noise with bounded error', () => {
    let x = 12345;
    const pcm = Int16Array.from({ length: 512 }, () => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return (x % 20000) - 10000;
    });
    const dec = decodeBrr(encodeBrr(pcm, null).data);
    expect(rmsError(pcm, dec)).toBeLessThan(1500);
  });

  it('forces filter 0 on the first block and the loop block, and flags loop and end', () => {
    const pcm = sine(256, 50);
    const enc = encodeBrr(pcm, 64);
    expect(enc.loopBlock).toBe(4);
    expect(parseHeader(enc.data[0]).filter).toBe(0);
    expect(parseHeader(enc.data[4 * BRR_BLOCK_BYTES]).filter).toBe(0);
    const last = parseHeader(enc.data[(enc.blocks - 1) * BRR_BLOCK_BYTES]);
    expect(last.end).toBe(true);
    expect(last.loop).toBe(true);
    // Somewhere in the smooth part a predictive filter beats filter 0.
    const filters = Array.from({ length: enc.blocks }, (_, b) => parseHeader(enc.data[b * BRR_BLOCK_BYTES]).filter);
    expect(filters.some((f) => f > 0)).toBe(true);
  });

  it('rejects unaligned input', () => {
    expect(() => encodeBrr(new Int16Array(15), null)).toThrow();
    expect(() => encodeBrr(new Int16Array(32), 5)).toThrow();
  });
});

describe('sample build: loop alignment', () => {
  const base = (pcm: Int16Array, loopStart: number, rate = 32000): Sample => ({
    id: 's',
    name: 's',
    pcm: int16ToBase64(pcm),
    sampleRate: rate,
    targetRate: 32000,
    rootNote: 60,
    fineTune: 0,
    loop: { enabled: true, start: loopStart },
  });

  it('leaves an already aligned loop untouched', () => {
    const b = buildSampleUncached(base(sine(256, 32), 128));
    expect(b.length).toBe(256);
    expect(b.loopBlock).toBe(8);
    expect(b.effectiveRate).toBe(32000);
    expect(b.notes).toEqual([]);
  });

  it('pads the start so the loop begins on a block boundary', () => {
    const b = buildSampleUncached(base(sine(100 + 64, 32), 100));
    expect(b.length % 16).toBe(0);
    expect(b.loopBlock * 16).toBe(b.length - 64);
    expect(b.notes.some((n) => n.includes('silence'))).toBe(true);
    expect(b.effectiveRate).toBe(32000);
  });

  it('resamples a loop whose length is not a multiple of 16 and reports the rate change', () => {
    const b = buildSampleUncached(base(sine(200, 50), 0));
    // 200 samples -> nearest multiple of 16 is 208.
    expect(b.length).toBe(208);
    expect(b.loopBlock).toBe(0);
    expect(b.effectiveRate).toBeCloseTo((32000 * 208) / 200, 6);
    expect(b.notes.some((n) => n.includes('resampled'))).toBe(true);
  });

  it('pads one-shot samples to whole blocks', () => {
    const s = base(sine(100, 20), 0);
    s.loop.enabled = false;
    const b = buildSampleUncached(s);
    expect(b.length).toBe(112);
    expect(b.loopBlock).toBe(-1);
  });
});
