import { emptyProject, newDevice, newPattern, newTrack, newZone } from '../model/defaults';
import type { Cell, Device, DeviceMode, Project } from '../model/types';
import { int16ToBase64 } from '../util/base64';

/**
 * Small, fully deterministic projects for compiler tests. One looping test sample plays at
 * exactly pitch 0x1000 on note 60, so expected pitch values are easy to reason about.
 */

export const TEST_SAMPLE_ID = 'smp_test';

function testPcm(): string {
  return int16ToBase64(Int16Array.from({ length: 64 }, (_, i) => (i % 32 < 16 ? 8000 : -8000)));
}

export interface TrackSpec {
  device: Device;
  columns?: number;
  /** [line, column, cell] */
  cells: [number, number, Cell][];
}

export function device(id: string, mode: DeviceMode, patch: Partial<Device> = {}): Device {
  return { ...newDevice(id, mode, [newZone(TEST_SAMPLE_ID)], id), ...patch };
}

export function fixture(tracks: TrackSpec[], patch: (p: Project) => void = () => {}, lines = 16): Project {
  const p = emptyProject();
  p.samples = [
    {
      id: TEST_SAMPLE_ID,
      name: 'test',
      pcm: testPcm(),
      sampleRate: 32000,
      targetRate: 32000,
      rootNote: 60,
      fineTune: 0,
      loop: { enabled: true, start: 0 },
    },
  ];
  const devices = new Map<string, Device>();
  for (const t of tracks) devices.set(t.device.id, t.device);
  p.devices = [...devices.values()];
  const pattern = newPattern(
    'P',
    lines,
    tracks.map((t) => newTrack(t.device.id, t.columns ?? 1, lines)),
    'pat_1',
  );
  tracks.forEach((t, ti) => {
    for (const [line, col, cell] of t.cells) pattern.tracks[ti].cells[line][col] = cell;
  });
  p.patterns = [pattern];
  p.order = [pattern.id];
  patch(p);
  return p;
}
