import { describe, expect, it } from 'vitest';
import { highestSignificantFrequency } from './spectrum';

/** One second-long loop region built from partials [frequency Hz, amplitude], at 32 kHz. */
function tones(partials: [number, number][], length = 3200): Int16Array {
  return Int16Array.from({ length }, (_, i) => Math.round(partials.reduce((s, [f, a]) => s + a * Math.sin((2 * Math.PI * f * i) / 32000), 0)));
}

describe('highest significant frequency', () => {
  it('finds the frequency of a sine', () => {
    expect(highestSignificantFrequency(tones([[1000, 8000]]), 32000, true)).toBeCloseTo(1000, -1);
  });

  it('counts a partial 30 dB down and ignores one 50 dB down', () => {
    expect(highestSignificantFrequency(tones([[1000, 10000], [5000, 316]]), 32000, true)).toBeCloseTo(5000, -1);
    expect(highestSignificantFrequency(tones([[1000, 10000], [5000, 32]]), 32000, true)).toBeCloseTo(1000, -1);
  });

  it('weights partials near the source Nyquist frequency by the Gaussian interpolation', () => {
    // 35 dB down at 15 kHz is within 40 dB, but the hardware filter takes another ~14 dB off.
    expect(highestSignificantFrequency(tones([[1000, 10000], [15000, 178]]), 32000, true)).toBeCloseTo(1000, -1);
  });

  it('scales with the sample rate', () => {
    expect(highestSignificantFrequency(tones([[1000, 8000]]), 16000, true)).toBeCloseTo(500, -1);
  });

  it('keeps a bright attack of a one-shot that decays (peak hold)', () => {
    const pcm = Int16Array.from({ length: 16000 }, (_, i) => {
      const bright = i < 2000 ? 3000 * Math.sin((2 * Math.PI * 9000 * i) / 32000) : 0;
      return Math.round(8000 * Math.sin((2 * Math.PI * 500 * i) / 32000) + bright);
    });
    expect(highestSignificantFrequency(pcm, 32000, false)).toBeCloseTo(9000, -2);
  });

  it('returns 0 for silence', () => {
    expect(highestSignificantFrequency(new Int16Array(4096), 32000, false)).toBe(0);
    expect(highestSignificantFrequency(new Int16Array(0), 32000, true)).toBe(0);
  });
});
