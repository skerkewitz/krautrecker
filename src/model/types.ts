/**
 * High-level project model: the composer's source of truth.
 *
 * Everything here is plain JSON-serializable data with stable string IDs. The low-level
 * 8-voice data (the IR) is never stored here; the compiler regenerates it from this model.
 */

export type SampleId = string;
export type DeviceId = string;
export type PatternId = string;

/** MIDI note number, 0..127. 60 = C-4. */
export type Note = number;

export interface Project {
  schemaVersion: number;
  title: string;
  author: string;
  timing: Timing;
  samples: Sample[];
  devices: Device[];
  patterns: Pattern[];
  /** Song arrangement: pattern IDs in play order. */
  order: PatternId[];
  hardware: HardwareSettings;
  /** Seed for every "random" behaviour, so compiling stays deterministic. */
  seed: number;
}

/**
 * Renoise-style timing. One line lasts `ticksPerLine` ticks; a beat has `linesPerBeat` lines.
 * The tick is the time resolution of the IR and of the sound driver.
 */
export interface Timing {
  bpm: number;
  linesPerBeat: number;
  ticksPerLine: number;
}

export interface HardwareSettings {
  /** Voices kept free for sound effects (taken from the top: 7, 6, ...). Music never uses them. */
  reservedSfxVoices: number;
  echo: EchoSettings;
  /** Main volume, signed 8-bit on hardware; 0..127 here. */
  mainVolume: number;
  /** ARAM reserved for the sound driver code in the estimate, in bytes. */
  driverReserve: number;
}

/**
 * The S-DSP has exactly one echo unit. Its buffer lives in ARAM: each 16 ms of delay costs 2 KB.
 */
export interface EchoSettings {
  /** Delay in 16 ms steps, 0..15 (0..240 ms). */
  delay: number;
  /** Feedback, signed 8-bit (-128..127). */
  feedback: number;
  /** Echo return volume left/right, signed 8-bit. */
  volumeL: number;
  volumeR: number;
  /** 8-tap FIR filter coefficients, signed 8-bit each. */
  fir: number[];
}

export interface Sample {
  id: SampleId;
  name: string;
  /** Original audio: mono, 16-bit signed PCM, little-endian, base64 encoded. */
  pcm: string;
  /** Sample rate of `pcm` in Hz. */
  sampleRate: number;
  /**
   * Rate the sample is resampled to before BRR encoding. Lower rates need less ARAM but sound
   * darker, because the BRR data then holds fewer samples per second.
   */
  targetRate: number;
  /** MIDI note the sample sounds at when played at its native rate. */
  rootNote: Note;
  /** Fine tune in cents, added to the root note. */
  fineTune: number;
  /** Loop end is always the sample end. Start is in samples of the original PCM. */
  loop: { enabled: boolean; start: number };
}

export type DeviceMode = 'mono' | 'legato' | 'poly' | 'arp' | 'drum';
export type ArpDirection = 'up' | 'down' | 'upDown' | 'asPlayed' | 'random';

/**
 * Hardware ADSR values, exactly as the S-DSP registers take them. Using the raw ranges keeps
 * the mapping to hardware obvious: there is no conversion that could drift.
 */
export interface Envelope {
  /** 0..15. 15 is instant. */
  attack: number;
  /** 0..7. */
  decay: number;
  /** 0..7. Sustain level = (sustainLevel + 1) / 8. */
  sustainLevel: number;
  /** 0..31. 0 = hold forever, 31 = fastest decay after the sustain level is reached. */
  sustainRate: number;
}

export interface Vibrato {
  /** Depth in semitones (peak). */
  depth: number;
  /** Period of one full cycle in ticks. */
  rate: number;
  /** Ticks after note-on before vibrato starts. */
  delay: number;
}

export interface ArpSettings {
  /** Ticks per arpeggio step. */
  rate: number;
  direction: ArpDirection;
  /** Octave range, 1..4. */
  octaves: number;
}

/** The instrument ("sampler"). A track plays exactly one device. */
export interface Device {
  id: DeviceId;
  name: string;
  zones: Zone[];
  mode: DeviceMode;
  /** Voice limit for `poly` and `drum`. Chords cost real hardware voices. */
  maxVoices: number;
  /** 0..255. Higher priority voices are stolen last, and never by a lower priority device. */
  priority: number;
  /** 0..127. */
  volume: number;
  /** -64..63. */
  pan: number;
  envelope: Envelope;
  vibrato: Vibrato | null;
  arp: ArpSettings;
  /** Portamento time for `legato` mode in ticks (0 = jump). */
  legatoPortamento: number;
  /** Route this device's voices to the echo unit. */
  echo: boolean;
}

export interface Zone {
  sampleId: SampleId;
  /** Inclusive key range. */
  keyRange: [Note, Note];
  rootNoteOverride?: Note;
  /** Drum zones: always play at this pitch, regardless of the key. */
  fixedPitch?: Note;
  /** 0..127. */
  volume: number;
  /** -64..63. */
  pan: number;
  envelope?: Envelope;
  /** Drum mode: a new note in a group cuts the running note of the same group. */
  chokeGroup?: number;
}

export interface Pattern {
  id: PatternId;
  name: string;
  lines: number;
  tracks: Track[];
}

export interface Track {
  deviceId: DeviceId | null;
  /** 1..8. More columns allow chords. */
  noteColumns: number;
  /** cells[line][column]; null = empty cell. */
  cells: (Cell | null)[][];
}

export const NOTE_OFF = 'OFF';
export const NOTE_CUT = 'CUT';
export type CellNote = Note | typeof NOTE_OFF | typeof NOTE_CUT;

export interface Cell {
  note?: CellNote;
  /** 0..127. */
  volume?: number;
  /** -64..63. */
  pan?: number;
  /** Note delay in ticks, 0..ticksPerLine-1. */
  delay?: number;
  fx?: Effect;
}

/**
 * Per-cell effect. `value` is one byte, interpreted per type (tracker style, so it fits in
 * one cell). Effects act only on the line they are written on.
 *
 * - slideUp / slideDown: value / 16 semitones per line
 * - porta: glide to the cell's note at value / 16 semitones per line (no retrigger)
 * - vibrato: high nibble = depth in quarter semitones, low nibble = period in 2-tick units
 * - volSlide: high nibble = volume up per tick, low nibble = volume down per tick
 * - cut: release the note after `value` ticks
 * - retrig: retrigger the note every `value` ticks
 */
export type EffectType = 'slideUp' | 'slideDown' | 'porta' | 'vibrato' | 'volSlide' | 'cut' | 'retrig';

export interface Effect {
  type: EffectType;
  value: number;
}
