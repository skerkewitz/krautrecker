import { BRR_BLOCK_BYTES, decodeBlock } from '../brr/brr';
import { modulatedPitch, NOISE_INITIAL, noiseSample, noiseStep } from './noise';
import { COUNTER_OFFSETS, COUNTER_RANGE, COUNTER_RATES, GAUSS } from './tables';

/**
 * A model of the S-DSP, the SNES sound chip, at 32 kHz. Pure TypeScript with no DOM access,
 * so it runs in an AudioWorklet and in unit tests alike.
 *
 * It models what defines the SNES sound: live BRR decoding (including the filter history
 * carrying over at the loop point), 4-point Gaussian interpolation, the 14-bit pitch register,
 * the hardware ADSR/GAIN envelope with its rate tables, per-voice L/R volume, the noise generator
 * and pitch modulation (see noise.ts), and the echo unit with its 8-tap FIR filter. It is not cycle-exact: register writes take effect immediately and
 * the key-on delay of a few samples is skipped.
 */

export interface DspSample {
  brr: Uint8Array;
  loopBlock: number;
}

/** Envelope as register values: hardware ADSR or a raw GAIN byte. */
export type DspEnvelope =
  | { mode: 'adsr'; attack: number; decay: number; sustainLevel: number; sustainRate: number }
  | { mode: 'gain'; gain: number };

export interface KeyOnParams {
  sampleSlot: number;
  pitch: number;
  volL: number;
  volR: number;
  envelope: DspEnvelope;
  echo: boolean;
}

export interface EchoParams {
  /** 0..15, in 16 ms steps. */
  delay: number;
  feedback: number;
  volumeL: number;
  volumeR: number;
  fir: number[];
}

const EnvMode = { Release: 0, Attack: 1, Decay: 2, Sustain: 3 } as const;

function clamp16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

function s8(v: number): number {
  return ((v & 0xff) << 24) >> 24;
}

class Voice {
  sample: DspSample | null = null;
  block = 0;
  blockBuf = new Int16Array(16);
  bufIndex = 16;
  /** Set when the block just played had the end flag. */
  blockEnd = false;
  blockLoop = false;
  hist = { p1: 0, p2: 0 };
  /** Interpolation window, oldest first. */
  w0 = 0;
  w1 = 0;
  w2 = 0;
  w3 = 0;
  /** Fractional position in 1/4096 samples. */
  interpPos = 0;
  pitch = 0;
  volL = 0;
  volR = 0;
  adsr0 = 0;
  adsr1 = 0;
  gain = 0;
  envMode: number = EnvMode.Release;
  env = 0;
  hiddenEnv = 0;
  echo = false;
  /** NON: output the noise generator instead of the sample. A register bit: key-on keeps it. */
  noise = false;
  /** PMON: pitch modulated by the previous voice's output. Ignored on voice 0, as on hardware. */
  pitchMod = false;
  /** Silent and idle: skip work. */
  idle = true;
  lastOut = 0;

  setEnvelope(e: DspEnvelope): void {
    if (e.mode === 'adsr') {
      this.adsr0 = 0x80 | ((e.decay & 7) << 4) | (e.attack & 15);
      this.adsr1 = ((e.sustainLevel & 7) << 5) | (e.sustainRate & 31);
    } else {
      this.adsr0 = 0;
      this.gain = e.gain & 0xff;
    }
  }

  /** Returns the next decoded BRR sample, fetching and decoding blocks as needed. */
  nextSample(): number {
    if (this.bufIndex >= 16) {
      const s = this.sample;
      if (!s) return 0;
      if (this.blockEnd) {
        // End of the sample: jump to the loop block. Without the loop flag the voice is
        // silenced at once (release mode, envelope forced to zero), as on hardware.
        this.block = s.loopBlock >= 0 ? s.loopBlock : 0;
        if (!this.blockLoop) {
          this.envMode = EnvMode.Release;
          this.env = 0;
        }
      }
      const offset = this.block * BRR_BLOCK_BYTES;
      if (offset + BRR_BLOCK_BYTES > s.brr.length) {
        this.sample = null;
        return 0;
      }
      const header = s.brr[offset];
      decodeBlock(s.brr, offset, this.hist, this.blockBuf, 0);
      this.blockEnd = (header & 1) !== 0;
      this.blockLoop = (header & 2) !== 0;
      this.block++;
      this.bufIndex = 0;
    }
    return this.blockBuf[this.bufIndex++];
  }
}

export class SDsp {
  readonly voices: Voice[] = Array.from({ length: 8 }, () => new Voice());
  samples: DspSample[] = [];
  mainVolL = 127;
  mainVolR = 127;
  private counter = 0;
  /** Global noise clock (FLG bits 0-4) and the noise shift register. */
  noiseClock = 0;
  private noiseLfsr = NOISE_INITIAL;
  private echoParams: EchoParams = { delay: 0, feedback: 0, volumeL: 0, volumeR: 0, fir: [127, 0, 0, 0, 0, 0, 0, 0] };
  private echoBuf = new Int16Array(2);
  private echoFrames = 1;
  private echoPos = 0;
  /** FLG bit 5 clear. When false the buffer is not written, so it keeps repeating its content. */
  echoWrite = true;
  private histL = new Int32Array(8);
  private histR = new Int32Array(8);
  /**
   * Sample frames where a 16-bit clamp changed the signal, for the offline analysis: the voice
   * mix, the echo input (incl. feedback) and the final output. A clamp in the voice mix is
   * inaudible in level meters, because main volume scales the already clamped sum down.
   */
  readonly clips = { voice: 0, echo: 0, output: 0 };

  setSamples(samples: DspSample[]): void {
    this.samples = samples;
    for (const v of this.voices) {
      v.sample = null;
      v.idle = true;
      v.env = 0;
    }
  }

  keyOn(voice: number, p: KeyOnParams): void {
    const v = this.voices[voice];
    const sample = this.samples[p.sampleSlot];
    v.sample = sample ?? null;
    v.block = 0;
    v.bufIndex = 16;
    v.blockEnd = false;
    v.blockLoop = false;
    v.hist.p1 = 0;
    v.hist.p2 = 0;
    v.w0 = v.w1 = v.w2 = v.w3 = 0;
    v.interpPos = 0;
    v.pitch = p.pitch & 0x3fff;
    v.volL = s8(p.volL);
    v.volR = s8(p.volR);
    v.setEnvelope(p.envelope);
    v.echo = p.echo;
    v.envMode = EnvMode.Attack;
    v.env = 0;
    v.hiddenEnv = 0;
    v.idle = !sample;
  }

  keyOff(voice: number): void {
    this.voices[voice].envMode = EnvMode.Release;
  }

  setPitch(voice: number, pitch: number): void {
    this.voices[voice].pitch = pitch & 0x3fff;
  }

  setVolume(voice: number, volL: number, volR: number): void {
    this.voices[voice].volL = s8(volL);
    this.voices[voice].volR = s8(volR);
  }

  setEnvelope(voice: number, e: DspEnvelope): void {
    this.voices[voice].setEnvelope(e);
  }

  setNoise(voice: number, enabled: boolean): void {
    this.voices[voice].noise = enabled;
  }

  setPitchMod(voice: number, enabled: boolean): void {
    this.voices[voice].pitchMod = enabled;
  }

  setNoiseClock(clock: number): void {
    this.noiseClock = clock & 0x1f;
  }

  /** Silences every voice immediately (used when playback stops). Noise and PMON start off again. */
  silence(): void {
    for (const v of this.voices) {
      v.envMode = EnvMode.Release;
      v.env = 0;
      v.idle = true;
      v.noise = false;
      v.pitchMod = false;
    }
  }

  setMainVolume(l: number, r: number): void {
    this.mainVolL = s8(l);
    this.mainVolR = s8(r);
  }

  setEcho(p: EchoParams): void {
    const frames = Math.max(1, (p.delay & 15) * 512);
    if (frames !== this.echoFrames) {
      this.echoFrames = frames;
      this.echoBuf = new Int16Array(frames * 2);
      this.echoPos = 0;
      this.histL.fill(0);
      this.histR.fill(0);
    }
    this.echoParams = { ...p, fir: p.fir.slice(0, 8) };
  }

  setEchoWrite(enabled: boolean): void {
    this.echoWrite = enabled;
  }

  /** True while any voice is sounding. */
  get active(): boolean {
    return this.voices.some((v) => !v.idle);
  }

  /** Current envelope level of a voice, 0..0x7FF (for meters). */
  envelopeLevel(voice: number): number {
    const v = this.voices[voice];
    return v.idle ? 0 : v.env;
  }

  private runEnvelope(v: Voice): void {
    let env = v.env;
    if (v.envMode === EnvMode.Release) {
      env -= 8;
      if (env <= 0) {
        env = 0;
        v.idle = true;
      }
      v.env = env;
      return;
    }
    let rate: number;
    let envData = v.adsr1;
    if (v.adsr0 & 0x80) {
      if (v.envMode >= EnvMode.Decay) {
        env--;
        env -= env >> 8;
        rate = envData & 0x1f;
        if (v.envMode === EnvMode.Decay) rate = ((v.adsr0 >> 3) & 0x0e) + 0x10;
      } else {
        rate = (v.adsr0 & 0x0f) * 2 + 1;
        env += rate < 31 ? 0x20 : 0x400;
      }
    } else {
      envData = v.gain;
      const mode = envData >> 5;
      if (mode < 4) {
        env = envData * 0x10;
        rate = 31;
      } else {
        rate = envData & 0x1f;
        if (mode === 4) env -= 0x20;
        else if (mode < 6) {
          env--;
          env -= env >> 8;
        } else {
          env += 0x20;
          if (mode > 6 && v.hiddenEnv >= 0x600) env += 0x8 - 0x20;
        }
      }
    }
    if (env >> 8 === envData >> 5 && v.envMode === EnvMode.Decay) v.envMode = EnvMode.Sustain;
    v.hiddenEnv = env;
    if (env < 0 || env > 0x7ff) {
      env = env < 0 ? 0 : 0x7ff;
      if (v.envMode === EnvMode.Attack) v.envMode = EnvMode.Decay;
    }
    if ((this.counter + COUNTER_OFFSETS[rate]) % COUNTER_RATES[rate] === 0) v.env = env;
  }

  /** Renders `count` stereo samples at 32 kHz into the float buffers (range -1..1), adding nothing. */
  render(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    const voices = this.voices;
    const ep = this.echoParams;
    const fir = ep.fir;
    for (let n = 0; n < count; n++) {
      if (--this.counter < 0) this.counter = COUNTER_RANGE - 1;
      const nc = this.noiseClock;
      if ((this.counter + COUNTER_OFFSETS[nc]) % COUNTER_RATES[nc] === 0) this.noiseLfsr = noiseStep(this.noiseLfsr);
      let mainL = 0;
      let mainR = 0;
      let echoL = 0;
      let echoR = 0;
      let rawL = 0;
      let rawR = 0;
      let rawEchoL = 0;
      let rawEchoR = 0;
      for (let i = 0; i < 8; i++) {
        const v = voices[i];
        if (v.idle) {
          v.lastOut = 0;
          continue;
        }
        // Gaussian interpolation between w1 and w2.
        const off = (v.interpPos >> 4) & 0xff;
        let out = (GAUSS[255 - off] * v.w0) >> 11;
        out += (GAUSS[511 - off] * v.w1) >> 11;
        out += (GAUSS[256 + off] * v.w2) >> 11;
        out = (out << 16) >> 16;
        out += (GAUSS[off] * v.w3) >> 11;
        out = clamp16(out) & ~1;
        if (v.noise) out = noiseSample(this.noiseLfsr);
        // Envelope.
        out = ((out * v.env) >> 11) & ~1;
        v.lastOut = out;
        this.runEnvelope(v);
        // Advance the sample position by the pitch register.
        v.interpPos += v.pitchMod && i > 0 ? modulatedPitch(v.pitch, voices[i - 1].lastOut) : v.pitch;
        while (v.interpPos >= 0x1000) {
          v.interpPos -= 0x1000;
          v.w0 = v.w1;
          v.w1 = v.w2;
          v.w2 = v.w3;
          v.w3 = v.nextSample();
        }
        const l = (out * v.volL) >> 7;
        const r = (out * v.volR) >> 7;
        mainL = clamp16(mainL + l);
        mainR = clamp16(mainR + r);
        rawL += l;
        rawR += r;
        if (v.echo) {
          echoL = clamp16(echoL + l);
          echoR = clamp16(echoR + r);
          rawEchoL += l;
          rawEchoR += r;
        }
      }

      // Echo: read the delayed sample, run the FIR filter, mix, write back with feedback.
      const pos = this.echoPos * 2;
      const hl = this.histL;
      const hr = this.histR;
      for (let k = 0; k < 7; k++) {
        hl[k] = hl[k + 1];
        hr[k] = hr[k + 1];
      }
      hl[7] = this.echoBuf[pos] >> 1;
      hr[7] = this.echoBuf[pos + 1] >> 1;
      let firL = 0;
      let firR = 0;
      for (let k = 0; k < 7; k++) {
        firL += (hl[k] * fir[k]) >> 6;
        firR += (hr[k] * fir[k]) >> 6;
      }
      firL = (firL << 16) >> 16;
      firR = (firR << 16) >> 16;
      firL = clamp16(firL + ((hl[7] * fir[7]) >> 6)) & ~1;
      firR = clamp16(firR + ((hr[7] * fir[7]) >> 6)) & ~1;

      const rawOutL = ((mainL * this.mainVolL) >> 7) + ((firL * ep.volumeL) >> 7);
      const rawOutR = ((mainR * this.mainVolR) >> 7) + ((firR * ep.volumeR) >> 7);
      const outLeft = clamp16(rawOutL);
      const outRight = clamp16(rawOutR);
      if (rawL !== mainL || rawR !== mainR) this.clips.voice++;
      if (rawOutL !== outLeft || rawOutR !== outRight) this.clips.output++;

      if (this.echoWrite) {
        const inL = echoL + ((firL * ep.feedback) >> 7);
        const inR = echoR + ((firR * ep.feedback) >> 7);
        this.echoBuf[pos] = clamp16(inL) & ~1;
        this.echoBuf[pos + 1] = clamp16(inR) & ~1;
        if (rawEchoL !== echoL || rawEchoR !== echoR || clamp16(inL) !== inL || clamp16(inR) !== inR) this.clips.echo++;
      }
      if (++this.echoPos >= this.echoFrames) this.echoPos = 0;

      outL[offset + n] = outLeft / 32768;
      outR[offset + n] = outRight / 32768;
    }
  }
}
