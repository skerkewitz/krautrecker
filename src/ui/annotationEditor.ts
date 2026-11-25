import { useSyncExternalStore } from 'react';
import { newId } from '../util/base64';
import { addComment, commentsAt, editComment, setChordMarker } from './harmonyEdit';
import { currentPattern, store, updatePattern } from './store';

/**
 * Which inline editor (chord marker or comment) is open in the pattern editor. This is transient
 * UI state, like a text field's focus, so it lives here rather than in the project or the store.
 */
export type AnnotationEdit =
  | { kind: 'chord'; patternId: string; line: number }
  | { kind: 'comment'; patternId: string; line: number; track: number | null; commentId: string | null };

let current: AnnotationEdit | null = null;
const listeners = new Set<() => void>();

function set(next: AnnotationEdit | null): void {
  current = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAnnotationEdit(): AnnotationEdit | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Opens the chord marker editor at a line of the current pattern (default: the cursor line). */
export function openChordEditor(line?: number): void {
  const s = store.getState();
  if (!currentPattern(s)) return;
  set({ kind: 'chord', patternId: s.ui.currentPatternId, line: line ?? s.ui.cursor.line });
}

/** Opens the comment editor at the cursor: on its cell's track, or on the whole line. */
export function openCommentEditor(wholeLine: boolean, commentId?: string): void {
  const s = store.getState();
  const pat = currentPattern(s);
  if (!pat) return;
  const line = s.ui.cursor.line;
  const track = wholeLine ? null : s.ui.cursor.track;
  const existing = commentId ? pat.comments.find((c) => c.id === commentId) : commentsAt(pat, line, track)[0];
  if (existing) set({ kind: 'comment', patternId: pat.id, line: existing.line, track: existing.track, commentId: existing.id });
  else set({ kind: 'comment', patternId: pat.id, line, track, commentId: null });
}

export function closeAnnotationEditor(): void {
  set(null);
}

/** Applies the editor's text: sets or removes the marker, or adds, edits or removes the comment. */
export function commitAnnotation(edit: AnnotationEdit, text: string): void {
  set(null);
  store.update((p) =>
    updatePattern(p, edit.patternId, (pat) => {
      if (edit.line >= pat.lines) return pat;
      if (edit.kind === 'chord') return setChordMarker(pat, edit.line, text);
      if (edit.commentId) return editComment(pat, edit.commentId, text);
      return addComment(pat, { id: newId('cmt'), line: edit.line, track: edit.track, text });
    }),
  );
}

/** Gives the keyboard back to the pattern grid, e.g. after closing an editor or jumping to a comment. */
export function focusPatternGrid(): void {
  document.querySelector<HTMLCanvasElement>('.pe-canvas')?.focus();
}
