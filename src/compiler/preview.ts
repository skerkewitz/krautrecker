import { buildSample } from '../brr/sampleBuild';
import type { Project } from '../model/types';
import { pitchFor } from './instrument';
import type { KeyOnData } from './ir';

/** Key-on data for auditioning a raw sample at its root note. */
export function previewSampleKeyOn(project: Project, sampleId: string): KeyOnData | null {
  const slot = project.samples.findIndex((s) => s.id === sampleId);
  if (slot < 0) return null;
  const sample = project.samples[slot];
  const { pitch } = pitchFor(sample.rootNote, sample.rootNote, sample.fineTune, buildSample(sample));
  return { sampleSlot: slot, pitch, volL: 100, volR: 100, envelope: { mode: 'adsr', attack: 15, decay: 7, sustainLevel: 7, sustainRate: 0 }, echo: false };
}
