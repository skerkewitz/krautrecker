import type { BuiltSample } from '../brr/sampleBuild';
import type { IR, KeyOnData } from '../compiler/ir';
import type { DspSample } from '../dsp/sdsp';
import { PROCESSOR_NAME, type FromWorklet, type ToWorklet } from '../dsp/protocol';
import { DSP_RATE } from '../dsp/tables';
import workletUrl from '../dsp/worklet.ts?worker&url';

export interface PlayPosition {
  tick: number;
  playing: boolean;
  levels: number[];
}

/**
 * Main-thread side of audio: owns the AudioContext and the worklet node, and forwards samples,
 * IR and transport commands. Browsers only allow audio after a user gesture, so the context is
 * created lazily on the first play or preview.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private lastSamples: BuiltSample[] | null = null;
  private lastIR: IR | null = null;
  private listeners = new Set<(p: PlayPosition) => void>();
  private previewVoice = 0;
  private previewHeld = new Map<string, number>();

  get contextRate(): number | null {
    return this.ctx?.sampleRate ?? null;
  }

  onPosition(fn: (p: PlayPosition) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Starts audio (needs a user gesture). Safe to call repeatedly. */
  ensureStarted(): Promise<void> {
    if (this.starting) return this.ctx?.state === 'suspended' ? this.ctx.resume() : this.starting;
    this.starting = (async () => {
      let ctx: AudioContext;
      try {
        // Run the context at the S-DSP's native rate so samples pass through unchanged.
        ctx = new AudioContext({ sampleRate: DSP_RATE, latencyHint: 'interactive' });
      } catch {
        ctx = new AudioContext({ latencyHint: 'interactive' });
      }
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(ctx.destination);
      node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
        if (e.data.type === 'position') for (const fn of this.listeners) fn(e.data);
      };
      this.ctx = ctx;
      this.node = node;
      if (this.lastSamples) this.send({ type: 'samples', samples: toDsp(this.lastSamples) });
      if (this.lastIR) this.send({ type: 'ir', ir: this.lastIR });
      if (ctx.state === 'suspended') await ctx.resume();
    })();
    return this.starting;
  }

  private send(m: ToWorklet): void {
    this.node?.port.postMessage(m);
  }

  /** Sends the sample bank if it changed (BuiltSample objects are cached, so identity works). */
  setSamples(samples: BuiltSample[]): void {
    const same = this.lastSamples && this.lastSamples.length === samples.length && this.lastSamples.every((s, i) => s === samples[i]);
    if (same) return;
    this.lastSamples = samples;
    this.send({ type: 'samples', samples: toDsp(samples) });
  }

  setIR(ir: IR): void {
    if (ir === this.lastIR) return;
    this.lastIR = ir;
    this.send({ type: 'ir', ir });
  }

  async play(ir: IR, from: number, loopStart: number, loop: boolean): Promise<void> {
    await this.ensureStarted();
    this.lastIR = ir;
    this.send({ type: 'ir', ir });
    this.send({ type: 'play', from, loopStart, loop });
  }

  stop(): void {
    this.send({ type: 'stop' });
  }

  /** Auditions a note on the preview DSP. `key` identifies the held key for the matching release. */
  async previewOn(key: string, keyOn: KeyOnData): Promise<void> {
    await this.ensureStarted();
    const old = this.previewHeld.get(key);
    const voice = old ?? this.previewVoice;
    if (old === undefined) this.previewVoice = (this.previewVoice + 1) % 8;
    this.previewHeld.set(key, voice);
    this.send({ type: 'previewOn', voice, keyOn });
  }

  previewOff(key: string): void {
    const voice = this.previewHeld.get(key);
    if (voice === undefined) return;
    this.previewHeld.delete(key);
    this.send({ type: 'previewOff', voice });
  }
}

function toDsp(samples: BuiltSample[]): DspSample[] {
  return samples.map((s) => ({ brr: s.brr, loopBlock: s.loopBlock }));
}

export const engine = new AudioEngine();
