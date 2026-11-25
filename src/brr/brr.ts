/**
 * BRR ("bit rate reduction"): the SNES sample format.
 *
 * A block is 9 bytes: one header byte and 8 data bytes holding 16 signed 4-bit nibbles
 * (high nibble first). The header holds a shift (bits 4-7), one of four prediction filters
 * (bits 2-3), the loop flag (bit 1) and the end flag (bit 0).
 *
 * The decoder below follows the S-DSP's integer arithmetic exactly, including its quirks:
 * samples are stored doubled with 16-bit wrap-around, and shifts 13-15 are invalid and
 * collapse to 0 or -2048. The encoder simulates this very decoder, so what it optimises for is
 * what the hardware will actually play.
 */

export const BRR_BLOCK_BYTES = 9;
export const BRR_BLOCK_SAMPLES = 16;

const FLAG_END = 1;
const FLAG_LOOP = 2;

/** The last two decoded samples, as the hardware stores them. */
export interface BrrHistory {
  p1: number;
  p2: number;
}

function clamp16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

/** Decodes one nibble (already sign-extended, -8..7) to one output sample. */
export function decodeSample(nibble: number, shift: number, filter: number, p1: number, p2: number): number {
  let s: number;
  if (shift <= 12) s = (nibble << shift) >> 1;
  else s = nibble < 0 ? -2048 : 0;
  const q2 = p2 >> 1;
  switch (filter) {
    case 1: // s += p1 * 15/16 (on the half-scale value)
      s += (p1 >> 1) + (-p1 >> 5);
      break;
    case 2: // s += p1 * 61/32 - p2 * 15/16
      s += p1 - q2 + (q2 >> 4) + ((p1 * -3) >> 6);
      break;
    case 3: // s += p1 * 115/64 - p2 * 13/16
      s += p1 - q2 + ((p1 * -13) >> 7) + ((q2 * 3) >> 4);
      break;
  }
  s = clamp16(s);
  return ((s * 2) << 16) >> 16;
}

export interface BrrHeader {
  shift: number;
  filter: number;
  loop: boolean;
  end: boolean;
}

export function parseHeader(byte: number): BrrHeader {
  return { shift: byte >> 4, filter: (byte >> 2) & 3, loop: (byte & FLAG_LOOP) !== 0, end: (byte & FLAG_END) !== 0 };
}

/** Decodes one 9-byte block into 16 samples, updating `hist`. */
export function decodeBlock(brr: Uint8Array, offset: number, hist: BrrHistory, out: Int16Array | number[], outOffset: number): void {
  const header = brr[offset];
  const shift = header >> 4;
  const filter = (header >> 2) & 3;
  let { p1, p2 } = hist;
  for (let i = 0; i < 16; i++) {
    const byte = brr[offset + 1 + (i >> 1)];
    const raw = i & 1 ? byte & 0x0f : byte >> 4;
    const nibble = (raw << 28) >> 28;
    const s = decodeSample(nibble, shift, filter, p1, p2);
    p2 = p1;
    p1 = s;
    out[outOffset + i] = s;
  }
  hist.p1 = p1;
  hist.p2 = p2;
}

/** Decodes a whole BRR stream once from the start (no looping). */
export function decodeBrr(brr: Uint8Array): Int16Array {
  const blocks = Math.floor(brr.length / BRR_BLOCK_BYTES);
  const out = new Int16Array(blocks * 16);
  const hist = { p1: 0, p2: 0 };
  for (let b = 0; b < blocks; b++) decodeBlock(brr, b * BRR_BLOCK_BYTES, hist, out, b * 16);
  return out;
}

export interface BrrEncodeResult {
  data: Uint8Array;
  blocks: number;
  /** Index of the block the loop jumps back to, or -1 when the sample does not loop. */
  loopBlock: number;
}

/**
 * Encodes 16-bit PCM to BRR. `pcm.length` must be a multiple of 16 and `loopStart` (if given)
 * a multiple of 16; the sample build step guarantees both.
 *
 * Per block, every filter (0-3) and shift (0-12) is tried and the one with the smallest squared
 * error wins. Nibbles are chosen greedily against the real decoder output, so prediction error
 * does not drift. The first block and the loop start block are forced to filter 0, because their
 * prediction history differs between the first pass and later loop passes; filter 0 ignores it.
 */
export function encodeBrr(pcm: Int16Array, loopStart: number | null): BrrEncodeResult {
  if (pcm.length % 16 !== 0) throw new Error('BRR input length must be a multiple of 16');
  if (loopStart !== null && loopStart % 16 !== 0) throw new Error('BRR loop start must be a multiple of 16');
  const blocks = Math.max(1, pcm.length / 16);
  const loopBlock = loopStart === null ? -1 : loopStart / 16;
  const data = new Uint8Array(blocks * BRR_BLOCK_BYTES);
  const hist = { p1: 0, p2: 0 };
  const nibbles = new Int8Array(16);
  const best = new Int8Array(16);

  for (let b = 0; b < blocks; b++) {
    const base = b * 16;
    const filters = b === 0 || b === loopBlock ? [0] : [0, 1, 2, 3];
    let bestErr = Infinity;
    let bestShift = 0;
    let bestFilter = 0;
    let bestP1 = 0;
    let bestP2 = 0;
    for (const filter of filters) {
      for (let shift = 0; shift <= 12; shift++) {
        let p1 = hist.p1;
        let p2 = hist.p2;
        let err = 0;
        for (let i = 0; i < 16; i++) {
          const target = base + i < pcm.length ? pcm[base + i] : 0;
          // First guess from the inverse of the decode formula, then check the neighbours.
          const predicted = decodeSample(0, shift, filter, p1, p2) / 2;
          const step = shift === 0 ? 0.5 : 1 << (shift - 1);
          let guess = Math.round((target / 2 - predicted) / step);
          guess = guess < -8 ? -8 : guess > 7 ? 7 : guess;
          let chosen = guess;
          let chosenOut = 0;
          let chosenErr = Infinity;
          for (let n = guess - 1; n <= guess + 1; n++) {
            if (n < -8 || n > 7) continue;
            const out = decodeSample(n, shift, filter, p1, p2);
            const e = (out - target) * (out - target);
            if (e < chosenErr) {
              chosenErr = e;
              chosen = n;
              chosenOut = out;
            }
          }
          nibbles[i] = chosen;
          err += chosenErr;
          p2 = p1;
          p1 = chosenOut;
          if (err >= bestErr) break;
        }
        if (err < bestErr) {
          bestErr = err;
          bestShift = shift;
          bestFilter = filter;
          bestP1 = p1;
          bestP2 = p2;
          best.set(nibbles);
        }
      }
    }
    const o = b * BRR_BLOCK_BYTES;
    let header = (bestShift << 4) | (bestFilter << 2);
    if (loopBlock >= 0) header |= FLAG_LOOP;
    if (b === blocks - 1) header |= FLAG_END;
    data[o] = header;
    for (let i = 0; i < 8; i++) {
      data[o + 1 + i] = ((best[i * 2] & 0x0f) << 4) | (best[i * 2 + 1] & 0x0f);
    }
    hist.p1 = bestP1;
    hist.p2 = bestP2;
  }
  return { data, blocks, loopBlock };
}
