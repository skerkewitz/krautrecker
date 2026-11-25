import { migrate } from '../model/schema';
import type { Project } from '../model/types';

/** The project file is the project itself as JSON; samples are already base64 inside. */
export function serializeProject(project: Project): string {
  return JSON.stringify(project);
}

export function parseProject(json: string): Project {
  return migrate(JSON.parse(json));
}

export function downloadProject(project: Project): void {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(project.title || 'project').replace(/[^\w\- ]+/g, '_')}.krautrecker.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
