import { GAUSS } from '../dsp/tables';

/**
 * Spectrum analysis for the aliasing check. The S-DSP resamples by stepping through the BRR data
 * at pitch / 0x1000 samples per output sample, with no low-pass filter that follows the pitch. A
 * partial at frequency f (at native playback) therefore plays at f * pitch / native pitch, and
 * anything that lands above 16 kHz (half the 32 kHz output rate) folds back as an off-pitch
 * partial. The sample build stores the highest significant frequency so the compiler can tell,
 * per key-on, whether that happens.
 */

/** Partials this far below the strongest one are ignored: roughly BRR's own quantisation noise. */
export const SIGNIFICANT_DB = 40;

/** Frame length of the analysis: 15.6 Hz resolution at 32 kHz. */
const FRAME = 2048;
const HOP = FRAME / 2;
/** Bins below this frequency never count as the strongest component (DC offset, rumble). */
const MIN_REFERENCE_HZ = 20;

/**
 * Highest frequency (Hz, at native playback) whose level is within `SIGNIFICANT_DB` of the
 * strongest component, or 0 for silence. `pcm` is the sample as encoded, at `rate` Hz. For a
 * looping sample pass only the loop: it is analysed as the endless repetition the hardware plays.
 *
 * Levels are weighted by the hardware's Gaussian interpolation, which acts on the source samples
 * and so attenuates the same partials at every pitch (about -10 dB at 0.4 x rate, -15 dB at 0.5 x).
 * Short-time spectra (Hann window, 50 % overlap) are combined by peak hold, so a bright attack
 * that decays counts as bright.
 */
export function highestSignificantFrequency(pcm: Int16Array, rate: number, looping: boolean): number {
  if (pcm.length === 0) return 0;
  const bins = FRAME / 2 + 1;
  const peak = new Float64Array(bins);
  const frames = looping ? Math.max(1, Math.ceil(pcm.length / HOP)) : Math.max(1, Math.ceil((pcm.length - HOP) / HOP));
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const win = hann();
  for (let f = 0; f < frames; f++) {
    const start = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      const j = start + i;
      // A loop is read cyclically, exactly as the hardware repeats it; a one-shot is zero-padded.
      const v = looping ? pcm[j % pcm.length] : j < pcm.length ? pcm[j] : 0;
      re[i] = v * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      const m = Math.hypot(re[k], im[k]);
      if (m > peak[k]) peak[k] = m;
    }
  }
  const gauss = gaussianResponse();
  let strongest = 0;
  const minBin = Math.ceil((MIN_REFERENCE_HZ * FRAME) / rate);
  for (let k = 0; k < bins; k++) {
    peak[k] *= gauss[k];
    if (k >= minBin && peak[k] > strongest) strongest = peak[k];
  }
  // Below about one LSB of a full frame the "component" is rounding noise, not content.
  if (strongest < FRAME / 4) return 0;
  const threshold = strongest * Math.pow(10, -SIGNIFICANT_DB / 20);
  let top = bins - 1;
  while (top > 0 && peak[top] < threshold) top--;
  if (top === 0) return 0;
  // The window spreads a partial over neighbouring bins: report the partial's own peak bin.
  while (top > 1 && peak[top - 1] > peak[top]) top--;
  return (top * rate) / FRAME;
}

let hannCache: Float64Array | null = null;
function hann(): Float64Array {
  if (!hannCache) {
    hannCache = new Float64Array(FRAME);
    for (let i = 0; i < FRAME; i++) hannCache[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  }
  return hannCache;
}

let gaussCache: Float64Array | null = null;
/**
 * Magnitude response of the S-DSP's 4-tap Gaussian interpolation per analysis bin, averaged over
 * the fractional positions, relative to DC.
 */
export function gaussianResponse(): Float64Array {
  if (gaussCache) return gaussCache;
  const bins = FRAME / 2 + 1;
  const out = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const nu = k / FRAME;
    let sum = 0;
    // Every 8th fractional position: the response varies smoothly with the position.
    for (let o = 4; o < 256; o += 8) {
      // Taps of the hardware filter for fractional position o/256, oldest sample first.
      const w = [GAUSS[255 - o], GAUSS[511 - o], GAUSS[256 + o], GAUSS[o]];
      let re = 0;
      let im = 0;
      let dc = 0;
      for (let t = 0; t < 4; t++) {
        const pos = t - 1 - o / 256;
        re += w[t] * Math.cos(2 * Math.PI * nu * pos);
        im += w[t] * Math.sin(2 * Math.PI * nu * pos);
        dc += w[t];
      }
      sum += Math.hypot(re, im) / dc;
    }
    out[k] = sum / 32;
  }
  gaussCache = out;
  return out;
}

/** In-place iterative radix-2 FFT; the length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}
