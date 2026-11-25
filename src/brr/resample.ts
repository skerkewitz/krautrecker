/**
 * Windowed-sinc resampler (Blackman window). Pure and deterministic. When downsampling, the
 * kernel is widened to low-pass at the new Nyquist frequency, so lowering `targetRate` darkens
 * the sound instead of adding aliasing.
 */
export function resample(input: Int16Array, srcRate: number, dstRate: number, outLength?: number): Int16Array {
  const ratio = dstRate / srcRate;
  const length = outLength ?? Math.max(0, Math.round(input.length * ratio));
  if (Math.abs(ratio - 1) < 1e-12 && length === input.length) return input.slice();
  const out = new Int16Array(length);
  const cutoff = Math.min(1, ratio);
  const halfWidth = Math.ceil(12 / cutoff);
  for (let j = 0; j < length; j++) {
    const x = j / ratio;
    const center = Math.floor(x);
    let sum = 0;
    let weightSum = 0;
    for (let k = center - halfWidth + 1; k <= center + halfWidth; k++) {
      const d = x - k;
      const w = blackman(d / halfWidth) * sinc(cutoff * d);
      weightSum += w;
      if (k >= 0 && k < input.length) sum += input[k] * w;
    }
    const v = weightSum !== 0 ? Math.round(sum / weightSum) : 0;
    out[j] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
  }
  return out;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Blackman window on [-1, 1]. */
function blackman(t: number): number {
  if (t <= -1 || t >= 1) return 0;
  const a = (t + 1) / 2;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * a) + 0.08 * Math.cos(4 * Math.PI * a);
}
