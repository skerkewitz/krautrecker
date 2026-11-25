import { LivePlayer } from './live';
import { SDsp } from './sdsp';
import { Sequencer } from './sequencer';
import { DSP_RATE } from './tables';
import { PROCESSOR_NAME, type FromWorklet, type ToWorklet } from './protocol';

// AudioWorkletGlobalScope declarations (not part of the DOM lib).
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const BLOCK = 128;
/** Report the play position about 30 times per second. */
const REPORT_EVERY = 1024;

/**
 * Runs the S-DSP model in the audio thread. The song DSP plays the compiled IR through the
 * sequencer. Live play runs the device rules on a second DSP, so live notes never disturb song
 * voices, and a third DSP auditions raw samples (it only renders while one is sounding).
 * Ideally the AudioContext runs at 32 kHz and samples pass straight through; otherwise this
 * resamples linearly to the context rate.
 */
class SDspProcessor extends AudioWorkletProcessor {
  private song = new SDsp();
  private live = new LivePlayer(new SDsp());
  private sampleDsp = new SDsp();
  private seq = new Sequencer(this.song);
  private bufL = new Float32Array(BLOCK);
  private bufR = new Float32Array(BLOCK);
  private prevL = new Float32Array(BLOCK);
  private prevR = new Float32Array(BLOCK);
  private step = DSP_RATE / sampleRate;
  /** Resampler state: position within the current 32 kHz buffer. */
  private pos = 0;
  private avail = 0;
  private lastL = 0;
  private lastR = 0;
  private sinceReport = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.onMessage(e.data);
  }

  private onMessage(m: ToWorklet): void {
    switch (m.type) {
      case 'samples':
        this.song.setSamples(m.samples);
        this.live.dsp.setSamples(m.samples);
        this.sampleDsp.setSamples(m.samples);
        break;
      case 'ir':
        this.seq.load(m.ir);
        break;
      case 'play':
        this.seq.play(m.from, m.loopStart, m.loop);
        break;
      case 'stop':
        this.seq.stop();
        break;
      case 'liveSetup':
        this.live.setup(m.setup);
        break;
      case 'liveOn':
        this.live.noteOn(m.deviceId, m.note, m.velocity);
        break;
      case 'liveOff':
        this.live.noteOff(m.deviceId, m.note);
        break;
      case 'liveAllOff':
        this.live.allNotesOff();
        break;
      case 'sampleOn':
        this.sampleDsp.keyOn(0, m.keyOn);
        break;
      case 'sampleOff':
        this.sampleDsp.keyOff(0);
        break;
    }
  }

  /** Produces the next 32 kHz block (song, live play and sample audition mixed). */
  private refill(): void {
    this.seq.render(this.bufL, this.bufR, 0, BLOCK);
    this.live.render(this.prevL, this.prevR, 0, BLOCK);
    this.mix();
    if (this.sampleDsp.active) {
      this.sampleDsp.render(this.prevL, this.prevR, 0, BLOCK);
      this.mix();
    }
    this.avail = BLOCK;
  }

  private mix(): void {
    for (let i = 0; i < BLOCK; i++) {
      this.bufL[i] += this.prevL[i];
      this.bufR[i] += this.prevR[i];
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    for (let i = 0; i < L.length; i++) {
      // Linear interpolation between the previous and current 32 kHz sample.
      while (this.pos >= this.avail) {
        if (this.avail > 0) {
          this.lastL = this.bufL[this.avail - 1];
          this.lastR = this.bufR[this.avail - 1];
        }
        this.pos -= this.avail;
        this.refill();
      }
      const idx = Math.floor(this.pos);
      const f = this.pos - idx;
      const l0 = idx === 0 ? this.lastL : this.bufL[idx - 1];
      const r0 = idx === 0 ? this.lastR : this.bufR[idx - 1];
      L[i] = l0 + (this.bufL[idx] - l0) * f;
      R[i] = r0 + (this.bufR[idx] - r0) * f;
      this.pos += this.step;
    }
    this.sinceReport += L.length;
    if (this.sinceReport >= REPORT_EVERY) {
      this.sinceReport = 0;
      const levels: number[] = [];
      for (let v = 0; v < 8; v++) levels.push(this.song.envelopeLevel(v));
      const msg: FromWorklet = { type: 'position', tick: this.seq.tick, playing: this.seq.playing, levels };
      this.port.postMessage(msg);
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, SDspProcessor);
