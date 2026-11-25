import type { Sample } from '../model/types';
import { int16ToBase64, newId } from '../util/base64';
import { floatToInt16, parseWav, type DecodedAudio } from './wav';

/** Longest sample we import, in seconds. ARAM is 64 KB; anything longer cannot fit anyway. */
const MAX_SECONDS = 10;

/** Imports an audio file as a new sample: WAV is parsed directly, anything else via the browser. */
export async function importAudioFile(file: File): Promise<Sample> {
  const buffer = await file.arrayBuffer();
  let audio: DecodedAudio;
  try {
    audio = parseWav(buffer);
  } catch {
    audio = await decodeWithBrowser(buffer);
  }
  let data = audio.data;
  if (data.length > audio.sampleRate * MAX_SECONDS) data = data.subarray(0, audio.sampleRate * MAX_SECONDS);
  const loopStart = audio.loopStart !== undefined && audio.loopStart < data.length ? audio.loopStart : undefined;
  return {
    id: newId('smp'),
    name: file.name.replace(/\.[^.]+$/, ''),
    pcm: int16ToBase64(floatToInt16(data)),
    sampleRate: audio.sampleRate,
    targetRate: Math.min(32000, audio.sampleRate),
    rootNote: 60,
    fineTune: 0,
    loop: { enabled: loopStart !== undefined, start: loopStart ?? 0 },
  };
}

async function decodeWithBrowser(buffer: ArrayBuffer): Promise<DecodedAudio> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const decoded = await ctx.decodeAudioData(buffer);
  const data = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] += ch[i] / decoded.numberOfChannels;
  }
  return { sampleRate: decoded.sampleRate, data };
}
