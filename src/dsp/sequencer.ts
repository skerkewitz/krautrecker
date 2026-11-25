import type { GlobalEvent, IR, VoiceEvent } from '../compiler/ir';
import type { SDsp } from './sdsp';
import { DSP_RATE } from './tables';

/**
 * Plays compiled IR on an S-DSP model: fires each tick's events, then renders that tick's
 * samples. This is the only playback path for the song, so what you hear is what the
 * compiled data says. Pure: it runs in the AudioWorklet and in tests.
 */

type TickEvent = { global: false; voice: number; ev: VoiceEvent } | { global: true; ev: GlobalEvent };

export class Sequencer {
  private byTick: TickEvent[][] = [];
  private global: GlobalEvent[] = [];
  private totalTicks = 0;
  private timing: IR['timing'] = { bpm: 125, linesPerBeat: 4, ticksPerLine: 6 };
  private irLoopTick = 0;
  private samplesPerTick = 1;
  private frac = 0;
  private samplesLeft = 0;
  playing = false;
  tick = 0;
  /** null = the loaded IR's loop point (follows recompiles while playing). */
  private loopStart: number | null = 0;
  private loop = false;

  constructor(readonly dsp: SDsp) {}

  load(ir: IR): void {
    const byTick: TickEvent[][] = Array.from({ length: ir.totalTicks }, () => []);
    for (const g of ir.global) byTick[g.tick]?.push({ global: true, ev: g });
    ir.voices.forEach((lane, voice) => {
      for (const ev of lane) byTick[ev.tick]?.push({ global: false, voice, ev });
    });
    this.byTick = byTick;
    this.global = ir.global;
    this.totalTicks = ir.totalTicks;
    this.timing = ir.timing;
    this.irLoopTick = ir.loopTick;
    this.samplesPerTick = this.samplesPerTickAt(ir.timing.bpm);
    // Global settings apply right away: while playing, the song's state at the play position
    // (an edit must not reset a tempo change); otherwise the initial state.
    if (this.playing) this.applyGlobalStateAt(this.tick);
    else for (const g of ir.global) if (g.tick === 0) this.applyGlobal(g);
  }

  /**
   * Starts playback at `fromTick`. After the end, a looping song continues at `loopStart`
   * (null = the IR's loop point).
   */
  play(fromTick: number, loopStart: number | null, loop: boolean): void {
    this.dsp.silence();
    this.tick = Math.max(0, Math.min(fromTick, this.totalTicks));
    this.loopStart = loopStart;
    this.loop = loop;
    this.frac = 0;
    this.samplesLeft = 0;
    this.playing = this.totalTicks > 0;
    this.applyGlobalStateAt(this.tick);
  }

  private samplesPerTickAt(bpm: number): number {
    const t = this.timing;
    return (DSP_RATE * 60) / (bpm * t.linesPerBeat * t.ticksPerLine);
  }

  /**
   * Brings tempo, volumes and echo to the state the song has just before `tick`, by replaying
   * the last global event of each type before it. Used when playback starts or loops mid-song;
   * the events on `tick` itself then fire as usual.
   */
  private applyGlobalStateAt(tick: number): void {
    // Defaults for state the IR only mentions when it differs from them.
    this.samplesPerTick = this.samplesPerTickAt(this.timing.bpm);
    this.dsp.setEchoWrite(true);
    const last = new Map<GlobalEvent['type'], GlobalEvent>();
    for (const g of this.global) if (g.tick < tick) last.set(g.type, g);
    for (const g of last.values()) this.applyGlobal(g);
  }

  stop(): void {
    this.playing = false;
    for (let v = 0; v < 8; v++) this.dsp.keyOff(v);
  }

  private applyGlobal(g: GlobalEvent): void {
    switch (g.type) {
      case 'tempo':
        // The IR stays tick-based; only the length of a tick changes.
        this.samplesPerTick = this.samplesPerTickAt(g.bpm);
        break;
      case 'echo':
        this.dsp.setEcho(g.params);
        break;
      case 'mainVolume':
        this.dsp.setMainVolume(g.volL, g.volR);
        break;
      case 'echoWrite':
        this.dsp.setEchoWrite(g.enabled);
        break;
      case 'noiseClock':
        this.dsp.setNoiseClock(g.clock);
        break;
    }
  }

  private fireTick(): void {
    if (this.tick >= this.totalTicks) {
      if (this.loop && this.totalTicks > 0) {
        this.dsp.silence();
        this.tick = Math.max(0, Math.min(this.loopStart ?? this.irLoopTick, this.totalTicks - 1));
        this.applyGlobalStateAt(this.tick);
      } else {
        this.stop();
        return;
      }
    }
    for (const e of this.byTick[this.tick] ?? []) {
      if (e.global) {
        this.applyGlobal(e.ev);
        continue;
      }
      applyVoiceEvent(this.dsp, e.voice, e.ev);
    }
    this.tick++;
    this.frac += this.samplesPerTick;
    this.samplesLeft = Math.floor(this.frac);
    this.frac -= this.samplesLeft;
  }

  /** Renders `count` samples at 32 kHz, firing ticks at their exact sample positions. */
  render(outL: Float32Array, outR: Float32Array, offset: number, count: number): void {
    let done = 0;
    while (done < count) {
      if (this.playing && this.samplesLeft <= 0) {
        this.fireTick();
        continue;
      }
      const chunk = this.playing ? Math.min(count - done, this.samplesLeft) : count - done;
      this.dsp.render(outL, outR, offset + done, chunk);
      done += chunk;
      if (this.playing) this.samplesLeft -= chunk;
    }
  }
}

/** Writes one IR voice event to the DSP's registers. Shared by song playback and live play. */
export function applyVoiceEvent(dsp: SDsp, voice: number, ev: VoiceEvent): void {
  switch (ev.type) {
    case 'keyOn':
      dsp.keyOn(voice, ev);
      break;
    case 'keyOff':
      dsp.keyOff(voice);
      break;
    case 'setPitch':
      dsp.setPitch(voice, ev.pitch);
      break;
    case 'setVolume':
      dsp.setVolume(voice, ev.volL, ev.volR);
      break;
    case 'setEnvelope':
      dsp.setEnvelope(voice, ev.envelope);
      break;
    case 'noise':
      dsp.setNoise(voice, ev.enabled);
      break;
    case 'pitchMod':
      dsp.setPitchMod(voice, ev.enabled);
      break;
  }
}
