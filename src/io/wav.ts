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
