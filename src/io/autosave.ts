import type { Project } from '../model/types';
import { parseProject, serializeProject } from './projectFile';

/** Autosave to IndexedDB: one record holding the serialized project. */

const DB = 'krautrecker';
const STORE = 'projects';
const KEY = 'autosave';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAutosave(project: Project): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(serializeProject(project), KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadAutosave(): Promise<Project | null> {
  try {
    const db = await open();
    const json = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return typeof json === 'string' ? parseProject(json) : null;
  } catch (e) {
    console.warn('Autosave could not be loaded', e);
    return null;
  }
}
