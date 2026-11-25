import { buildSample } from '../brr/sampleBuild';
import type { Project } from '../model/types';
import { pitchFor, selectZone, stereoVolume, toDspEnvelope, zoneRoot } from './instrument';
import type { KeyOnData } from './ir';

/**
 * Key-on data for auditioning one note on a device (live play, note entry). It uses the same
 * zone selection, pitch and volume rules as the compiler, so a preview sounds like playback.
 * Device modes (arp, legato) do not apply: a preview is a single plain note.
 */
export function previewKeyOn(project: Project, deviceId: string, note: number, velocity = 127): KeyOnData | null {
  const device = project.devices.find((d) => d.id === deviceId);
  if (!device) return null;
  const samples = new Map(project.samples.map((s) => [s.id, s]));
  const match = selectZone(device, note, samples);
  if (!match) return null;
  const zone = match.zone;
  const slot = project.samples.findIndex((s) => s.id === zone.sampleId);
  if (slot < 0) return null;
  const sample = project.samples[slot];
  const playNote = device.mode === 'drum' && zone.fixedPitch !== undefined ? zone.fixedPitch : note;
  const { pitch } = pitchFor(playNote, zoneRoot(zone, samples), sample.fineTune, buildSample(sample));
  const volume = Math.round((device.volume * zone.volume * velocity) / (127 * 127));
  return {
    sampleSlot: slot,
    pitch,
    ...stereoVolume(volume, device.pan + zone.pan),
    envelope: toDspEnvelope(zone.envelope ?? device.envelope),
    echo: device.echo,
  };
}

/** Key-on data for auditioning a raw sample at its root note. */
export function previewSampleKeyOn(project: Project, sampleId: string): KeyOnData | null {
  const slot = project.samples.findIndex((s) => s.id === sampleId);
  if (slot < 0) return null;
  const sample = project.samples[slot];
  const { pitch } = pitchFor(sample.rootNote, sample.rootNote, sample.fineTune, buildSample(sample));
  return { sampleSlot: slot, pitch, volL: 100, volR: 100, envelope: { mode: 'adsr', attack: 15, decay: 7, sustainLevel: 7, sustainRate: 0 }, echo: false };
}
