/**
 * Minimal WAV reader: PCM 8/16/24/32-bit and IEEE float 32/64, any channel count, mixed to mono.
 * Reading WAV ourselves keeps the file's original sample rate (decodeAudioData would resample
 * to the AudioContext rate) and reads the loop point from a `smpl` chunk if there is one.
 */

export interface DecodedAudio {
  sampleRate: number;
  /** Mono, -1..1. */
  data: Float32Array;
  /** Loop start in samples from a `smpl` chunk, if present. */
  loopStart?: number;
}

export function parseWav(buffer: ArrayBuffer): DecodedAudio {
  const view = new DataView(buffer);
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataLength = 0;
  let loopStart: number | undefined;

  let o = 12;
  while (o + 8 <= buffer.byteLength) {
    const id = tag(o);
    const size = view.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buffer.byteLength - body);
    } else if (id === 'smpl' && size >= 36) {
      const loops = view.getUint32(body + 28, true);
      if (loops > 0 && size >= 36 + 24) loopStart = view.getUint32(body + 36 + 8, true);
    }
    o = body + size + (size & 1);
  }
  if (dataOffset < 0 || channels === 0) throw new Error('WAV file has no audio data');
  if (format !== 1 && format !== 3) throw new Error(`Unsupported WAV encoding (format ${format})`);

  const bytes = bits / 8;
  const frames = Math.floor(dataLength / (bytes * channels));
  const data = new Float32Array(frames);
  const read = (p: number): number => {
    if (format === 3) return bits === 64 ? view.getFloat64(p, true) : view.getFloat32(p, true);
    switch (bits) {
      case 8:
        return (view.getUint8(p) - 128) / 128;
      case 16:
        return view.getInt16(p, true) / 32768;
      case 24: {
        const v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16);
        return v / 8388608;
      }
      case 32:
        return view.getInt32(p, true) / 2147483648;
      default:
        throw new Error(`Unsupported bit depth ${bits}`);
    }
  };
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(dataOffset + (f * channels + c) * bytes);
    data[f] = sum / channels;
  }
  return { sampleRate, data, loopStart };
}

export function floatToInt16(data: Float32Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(data[i] * 32767);
    out[i] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
  }
  return out;
}

/**
 * Stereo 16-bit PCM WAV. Input is the DSP's float output (-1..1, exactly int16 / 32768), so the
 * samples are scaled by 32768 and come out bit-identical to the S-DSP model's output.
 */
export function encodeWav16(left: Float32Array, right: Float32Array, sampleRate: number): Uint8Array {
  const frames = Math.min(left.length, right.length);
  const dataBytes = frames * 4;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);
  const toInt = (x: number) => {
    const v = Math.round(x * 32768);
    return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
  };
  for (let f = 0; f < frames; f++) {
    view.setInt16(44 + f * 4, toInt(left[f]), true);
    view.setInt16(46 + f * 4, toInt(right[f]), true);
  }
  return new Uint8Array(buf);
}
