import { newId } from '../util/base64';
import type { Cell, Device, DeviceMode, Envelope, Pattern, Project, Track, Zone } from './types';

/**
 * Version 2 added effect columns, release/GAIN, tremolo, noise, pitch modulation, track mix and the
 * loop point. Version 3 added the song key, chord markers and line comments.
 */
export const SCHEMA_VERSION = 3;

/** Instant attack, no decay, full sustain: the note holds until key-off. */
export const DEFAULT_ENVELOPE: Envelope = { attack: 15, decay: 7, sustainLevel: 7, sustainRate: 0 };

/**
 * Device fields with their neutral values: a device with only these behaves exactly like a
 * version-1 device. The migration fills them in for old projects.
 */
export const DEVICE_DEFAULTS: Pick<Device, 'gain' | 'release' | 'tremolo' | 'fineTune' | 'surround' | 'pitchModSource'> = {
  gain: null,
  release: { mode: 'hardware', rate: 20 },
  tremolo: null,
  fineTune: 0,
  surround: false,
  pitchModSource: null,
};

/** Track mix fields with their neutral values. */
export const TRACK_DEFAULTS: Pick<Track, 'volume' | 'pan' | 'transpose'> = { volume: 127, pan: 0, transpose: 0 };

export function newDevice(name: string, mode: DeviceMode = 'poly', zones: Zone[] = [], id = newId('dev')): Device {
  return {
    id,
    name,
    zones,
    mode,
    maxVoices: mode === 'drum' ? 4 : 3,
    priority: 128,
    volume: 100,
    pan: 0,
    envelope: { ...DEFAULT_ENVELOPE },
    ...DEVICE_DEFAULTS,
    release: { ...DEVICE_DEFAULTS.release },
    vibrato: null,
    arp: { rate: 3, direction: 'up', octaves: 1 },
    legatoPortamento: 0,
    echo: false,
  };
}

export function newZone(sampleId: string, keyRange: [number, number] = [0, 127]): Zone {
  return { sampleId, keyRange, volume: 127, pan: 0 };
}

export function emptyCells(lines: number, columns: number): (Cell | null)[][] {
  return Array.from({ length: lines }, () => Array.from({ length: columns }, () => null));
}

export function newTrack(deviceId: string | null, noteColumns: number, lines: number): Track {
  return { deviceId, noteColumns, ...TRACK_DEFAULTS, cells: emptyCells(lines, noteColumns) };
}

export function newPattern(name: string, lines: number, tracks: Track[], id = newId('pat')): Pattern {
  return { id, name, lines, tracks, key: null, chords: [], comments: [] };
}

export function emptyProject(): Project {
  const pattern = newPattern('Pattern 1', 64, [newTrack(null, 1, 64), newTrack(null, 1, 64), newTrack(null, 1, 64), newTrack(null, 1, 64)]);
  return {
    schemaVersion: SCHEMA_VERSION,
    title: 'Untitled',
    author: '',
    timing: { bpm: 125, linesPerBeat: 4, ticksPerLine: 6 },
    samples: [],
    devices: [],
    patterns: [pattern],
    order: [pattern.id],
    loopOrderIndex: 0,
    key: null,
    hardware: {
      reservedSfxVoices: 0,
      echo: { delay: 0, feedback: 0, volumeL: 0, volumeR: 0, fir: [127, 0, 0, 0, 0, 0, 0, 0], writeEnabled: true },
      mainVolumeL: 100,
      mainVolumeR: 100,
      driverReserve: 8192,
    },
    seed: 1,
  };
}
