import { useMemo } from 'react';
import { hex } from '../model/notes';
import { focusPatternGrid, openCommentEditor } from './annotationEditor';
import { commentsInSongOrder, removeComment, type CommentEntry } from './harmonyEdit';
import { store, updatePattern, useStore } from './store';

/**
 * The bottom panel's comment list: every comment in song order with its position. Clicking one
 * moves the cursor to its cell, like a diagnostic.
 */
export function CommentsPanel() {
  const project = useStore((s) => s.project);
  const entries = useMemo(() => commentsInSongOrder(project), [project]);

  const jump = (e: CommentEntry) => {
    const cursor = store.getState().ui.cursor;
    const track = e.comment.track ?? (e.pattern.tracks[cursor.track] ? cursor.track : 0);
    store.setUi({
      currentPatternId: e.pattern.id,
      orderIndex: e.orderIndex,
      cursor: { track, column: e.comment.track === null && track === cursor.track ? cursor.column : 0, field: 0, line: e.comment.line },
      selection: null,
    });
    focusPatternGrid();
  };

  return (
    <div className="pane comments">
      <div className="pane-summary">
        <span className="dim">
          {entries.length} {entries.length === 1 ? 'comment' : 'comments'} · Ctrl+M comments the cursor cell, Ctrl+Alt+M the whole line
        </span>
      </div>
      <div className="diag-list">
        {entries.length === 0 && <div className="dim">No comments yet.</div>}
        {entries.map((e) => (
          <div key={`${e.pattern.id}:${e.comment.id}`} className="diag comment link" onClick={() => jump(e)}>
            <span className="where">
              {`${e.orderIndex >= 0 ? hex(e.orderIndex, 2) : '--'}:${hex(e.comment.line, 2)} ${e.comment.track === null ? 'line' : `T${e.comment.track + 1}`}`}
            </span>
            <span className="cmt-pattern">{e.pattern.name}</span>
            <span className="cmt-text">{e.comment.text}</span>
            <button
              className="icon-button"
              title="Edit this comment"
              aria-label="Edit comment"
              onClick={(ev) => {
                ev.stopPropagation();
                jump(e);
                openCommentEditor(e.comment.track === null, e.comment.id);
              }}
            >
              ✎
            </button>
            <button
              className="icon-button danger"
              title="Delete this comment"
              aria-label="Delete comment"
              onClick={(ev) => {
                ev.stopPropagation();
                store.update((p) => updatePattern(p, e.pattern.id, (pat) => removeComment(pat, e.comment.id)));
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
