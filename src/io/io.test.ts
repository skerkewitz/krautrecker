import { describe, expect, it } from 'vitest';
import { compileSong } from '../compiler/compile';
import { SCHEMA_VERSION } from '../model/defaults';
import { grooveProject } from '../model/demo';
import { base64ToInt16, int16ToBase64 } from '../util/base64';
import { parseProject, serializeProject } from './projectFile';
import { parseWav } from './wav';

describe('project file', () => {
  it('save and reload gives an identical project and identical IR', () => {
    const project = grooveProject();
    const reloaded = parseProject(serializeProject(project));
    expect(reloaded).toEqual(project);
    expect(JSON.stringify(compileSong(reloaded))).toBe(JSON.stringify(compileSong(project)));
  });

  it('rejects files from a newer schema and files without a version', () => {
    expect(() => parseProject(JSON.stringify({ ...grooveProject(), schemaVersion: SCHEMA_VERSION + 1 }))).toThrow(/newer/);
    expect(() => parseProject('{"title":"x"}')).toThrow(/schemaVersion/);
  });

  it('fills missing optional settings with defaults', () => {
    const raw = JSON.parse(serializeProject(grooveProject()));
    delete raw.hardware.driverReserve;
    expect(parseProject(JSON.stringify(raw)).hardware.driverReserve).toBe(8192);
  });

  it('migrates a schema 1 project: effect lists, main volume L/R, neutral new fields, same IR', () => {
    // Build what a version-1 file looked like from the current demo.
    const v2 = grooveProject();
    const v1 = JSON.parse(serializeProject(v2));
    v1.schemaVersion = 1;
    v1.hardware.mainVolume = v1.hardware.mainVolumeL;
    delete v1.hardware.mainVolumeL;
    delete v1.hardware.mainVolumeR;
    delete v1.hardware.echo.writeEnabled;
    delete v1.loopOrderIndex;
    for (const d of v1.devices) {
      for (const k of ['gain', 'release', 'tremolo', 'fineTune', 'surround', 'pitchModSource']) delete d[k];
      if (d.vibrato) delete d.vibrato.fadeIn;
    }
    for (const pat of v1.patterns) {
      for (const t of pat.tracks) {
        delete t.volume;
        delete t.pan;
        delete t.transpose;
        for (const row of t.cells) for (const cell of row) if (cell?.fx) cell.fx = cell.fx[0];
      }
    }
    const migrated = parseProject(JSON.stringify(v1));
    expect(migrated).toEqual(v2);
    expect(JSON.stringify(compileSong(migrated))).toBe(JSON.stringify(compileSong(v2)));
  });

  it('stores PCM losslessly as base64', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 12345, -54]);
    expect(Array.from(base64ToInt16(int16ToBase64(pcm)))).toEqual(Array.from(pcm));
  });
});

function wav(channels: number, rate: number, bits: number, frames: number[][], format = 1, smplLoop?: number): ArrayBuffer {
  const bytes = bits / 8;
  const dataLen = frames.length * channels * bytes;
  const smplLen = smplLoop !== undefined ? 8 + 36 + 24 : 0;
  const buf = new ArrayBuffer(12 + 24 + 8 + dataLen + smplLen);
  const v = new DataView(buf);
  const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, buf.byteLength - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, format, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * bytes, true);
  v.setUint16(32, channels * bytes, true);
  v.setUint16(34, bits, true);
  tag(36, 'data');
  v.setUint32(40, dataLen, true);
  let o = 44;
  for (const f of frames) {
    for (const s of f) {
      if (bits === 16) v.setInt16(o, s, true);
      else if (bits === 8) v.setUint8(o, s);
      else if (bits === 32 && format === 3) v.setFloat32(o, s, true);
      o += bytes;
    }
  }
  if (smplLoop !== undefined) {
    tag(o, 'smpl');
    v.setUint32(o + 4, 36 + 24, true);
    v.setUint32(o + 8 + 28, 1, true);
    v.setUint32(o + 8 + 36 + 8, smplLoop, true);
  }
  return buf;
}

describe('WAV reader', () => {
  it('reads 16-bit mono with its original rate', () => {
    const a = parseWav(wav(1, 22050, 16, [[16384], [-16384], [0]]));
    expect(a.sampleRate).toBe(22050);
    expect(Array.from(a.data)).toEqual([0.5, -0.5, 0]);
  });

  it('mixes stereo to mono', () => {
    const a = parseWav(wav(2, 44100, 16, [[16384, 0], [-16384, -16384]]));
    expect(Array.from(a.data)).toEqual([0.25, -0.5]);
  });

  it('reads 8-bit unsigned and 32-bit float', () => {
    expect(Array.from(parseWav(wav(1, 8000, 8, [[128], [192]])).data)).toEqual([0, 0.5]);
    expect(Array.from(parseWav(wav(1, 8000, 32, [[0.25], [-1]], 3)).data)).toEqual([0.25, -1]);
  });

  it('reads the loop start from a smpl chunk', () => {
    expect(parseWav(wav(1, 32000, 16, [[0], [1], [2], [3]], 1, 2)).loopStart).toBe(2);
  });

  it('rejects non-WAV data', () => {
    expect(() => parseWav(new ArrayBuffer(20))).toThrow();
  });
});
