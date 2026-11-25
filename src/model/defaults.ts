import { newId } from '../util/base64';
import type { Cell, Device, DeviceMode, Envelope, Pattern, Project, Track, Zone } from './types';

export const SCHEMA_VERSION = 1;

/** Instant attack, no decay, full sustain: the note holds until key-off. */
export const DEFAULT_ENVELOPE: Envelope = { attack: 15, decay: 7, sustainLevel: 7, sustainRate: 0 };

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
  return { deviceId, noteColumns, cells: emptyCells(lines, noteColumns) };
}

export function newPattern(name: string, lines: number, tracks: Track[], id = newId('pat')): Pattern {
  return { id, name, lines, tracks };
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
    hardware: {
      reservedSfxVoices: 0,
      echo: { delay: 0, feedback: 0, volumeL: 0, volumeR: 0, fir: [127, 0, 0, 0, 0, 0, 0, 0] },
      mainVolume: 100,
      driverReserve: 8192,
    },
    seed: 1,
  };
}
