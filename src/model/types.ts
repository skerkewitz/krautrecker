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
  /**
   * Song loop point: after the last order entry, playback continues at this order index.
   * Almost every SNES track plays an intro once and then loops a later section.
   */
  loopOrderIndex: number;
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
  /** Main volume left/right, signed 8-bit registers (-128..127). */
  mainVolumeL: number;
  mainVolumeR: number;
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
  /**
   * Echo buffer writes (FLG bit 5 clear). When false, the buffer is frozen and keeps repeating
   * what it holds; the buffer still occupies ARAM.
   */
  writeEnabled: boolean;
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
  /** Ticks over which the depth fades in after the delay (0 = full depth at once). */
  fadeIn: number;
}

/** Periodic volume modulation, the volume counterpart of vibrato. */
export interface Tremolo {
  /** Depth in volume units (0..127, peak). */
  depth: number;
  /** Period of one full cycle in ticks. */
  rate: number;
  /** Ticks after note-on before tremolo starts. */
  delay: number;
}

/**
 * What happens at note-off. The S-DSP's own release (key-off) is fixed: the envelope drops to
 * zero in about 8 ms. Drivers get longer releases by switching the voice to a GAIN decrease mode
 * at note-off and keying it off only once it is silent.
 */
export interface Release {
  /** 'hardware' = plain key-off (8 ms). 'exp' / 'linear' = GAIN exponential / linear decrease. */
  mode: 'hardware' | 'exp' | 'linear';
  /** GAIN rate 1..31 for 'exp' / 'linear' (hardware rate table; higher = faster). Ignored for 'hardware'. */
  rate: number;
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
  /**
   * Advanced: play notes with this raw GAIN byte instead of the ADSR envelope (null = use ADSR).
   * 0x00-0x7F direct level, 0x80-0x9F linear decrease, 0xA0-0xBF exponential decrease,
   * 0xC0-0xDF linear increase, 0xE0-0xFF bent-line increase; the low 5 bits are the rate.
   */
  gain: number | null;
  release: Release;
  vibrato: Vibrato | null;
  tremolo: Tremolo | null;
  /** Fine tune in cents, added to every note of this device (detune). */
  fineTune: number;
  arp: ArpSettings;
  /** Portamento time for `legato` mode in ticks (0 = jump). */
  legatoPortamento: number;
  /** Route this device's voices to the echo unit. */
  echo: boolean;
  /**
   * Invert the right channel's phase (negative right volume): the classic SNES "surround" effect,
   * which widens the sound on stereo speakers and moves it behind the listener on Dolby Surround.
   */
  surround: boolean;
  /**
   * Pitch modulation (PMON): this device's voices are frequency-modulated by the output of the
   * voice just below them (voice n-1), which must be playing a note of the source device.
   * null = off.
   */
  pitchModSource: DeviceId | null;
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
  /**
   * Play the S-DSP noise generator instead of the sample, at this noise clock (0..31, the hardware
   * rate table). The noise clock is global: all noise voices share whichever clock was set last.
   */
  noise?: number;
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
  /** Track (channel) volume 0..127, multiplied into every note. */
  volume: number;
  /** Track pan -64..63, added to note pan. */
  pan: number;
  /** Semitones added to every note of this track. */
  transpose: number;
  /** cells[line][column]; null = empty cell. */
  cells: (Cell | null)[][];
}

export const NOTE_OFF = 'OFF';
export const NOTE_CUT = 'CUT';
export type CellNote = Note | typeof NOTE_OFF | typeof NOTE_CUT;

/** Effect columns per note column. */
export const FX_COLUMNS = 2;

export interface Cell {
  note?: CellNote;
  /** 0..127. */
  volume?: number;
  /** -64..63. */
  pan?: number;
  /** Note delay in ticks, 0..ticksPerLine-1. */
  delay?: number;
  /** Up to FX_COLUMNS effects; index = effect column. Missing or null entries are empty. */
  fx?: (Effect | null)[];
}

/**
 * Per-cell effect. `value` is one byte, interpreted per type (tracker style, so it fits in one
 * cell). Effects act on the line they are written on. Effect memory (FT2 convention): for the
 * effects marked "memory", a value of 00 repeats the last non-zero value of that effect type in
 * the same note column, so a slide is continued by writing the letter with 00 on each line.
 *
 * Note effects (apply to the note of their column):
 * - slideUp U / slideDown D: value / 16 semitones per line. Memory.
 * - porta P: glide to the cell's note at value / 16 semitones per line, no retrigger. Memory.
 * - vibrato V: x = depth in quarter semitones, y = period in 2-tick units. Memory (per nibble).
 * - tremolo T: x = depth in 8-volume-unit steps, y = period in 2-tick units. Memory (per nibble).
 * - volSlide A: x = volume up per tick, y = volume down per tick. Memory.
 * - panSlide L: x = pan right per tick, y = pan left per tick. Memory.
 * - cut C: release the note after value ticks.
 * - retrig R: retrigger the note every value ticks. Memory.
 * - gain G: switch the sounding note to this raw GAIN byte (see Device.gain); the next note
 *   uses the device envelope again.
 * - noise N: 00-1F switch the note to noise at that noise clock; 20-FF switch noise off.
 *
 * Track effects (apply to the track as a whole and persist):
 * - trackVolume M: set track volume to value (00-7F).
 * - trackVolSlide K: x = up per tick, y = down per tick. Memory.
 * - trackPan X: set track pan, 00-7F (40 = centre).
 *
 * Global effects (apply to the whole song and persist):
 * - tempo F: set BPM to value (20-FF = 32-255).
 * - mainVolume W: set main volume (both sides) to value (00-7F).
 * - mainVolSlide H: x = up per tick, y = down per tick. Memory.
 * - echoVolume E: set echo return volume (both sides) to value (00-7F).
 * - echoVolSlide Y: x = up per tick, y = down per tick. Memory.
 * - echoFeedback B: set echo feedback, value read as signed (80-FF = -128..-1).
 * - echoWrite Z: 00 freezes the echo buffer, any other value enables writes again.
 */
export type EffectType =
  | 'slideUp'
  | 'slideDown'
  | 'porta'
  | 'vibrato'
  | 'tremolo'
  | 'volSlide'
  | 'panSlide'
  | 'cut'
  | 'retrig'
  | 'gain'
  | 'noise'
  | 'trackVolume'
  | 'trackVolSlide'
  | 'trackPan'
  | 'tempo'
  | 'mainVolume'
  | 'mainVolSlide'
  | 'echoVolume'
  | 'echoVolSlide'
  | 'echoFeedback'
  | 'echoWrite';

export interface Effect {
  type: EffectType;
  value: number;
}
