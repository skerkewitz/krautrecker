import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { parseChord } from '../model/harmony';
import { hex } from '../model/notes';
import type { ChordMarker, Pattern } from '../model/types';
import { LINE_NUMBER_CHARS } from './annotationCanvas';
import { closeAnnotationEditor, commitAnnotation, focusPatternGrid, useAnnotationEdit, type AnnotationEdit } from './annotationEditor';
import { chordMarkerAt, commentsAt } from './harmonyEdit';
import { theme } from './theme';

/** What the mouse is over in the pattern grid: the line numbers, the chord lane, or a track. */
export interface HoverTarget {
  line: number;
  area: 'gutter' | 'lane' | 'track';
  track: number;
}

interface Props {
  pattern: Pattern;
  first: number;
  rows: number;
  cw: number;
  /** Track start positions in chars. */
  trackX: number[];
  /** Height of the track headers above the grid canvas. */
  top: number;
  hover: HoverTarget | null;
  /** Marker carried into this pattern from earlier patterns in song order. */
  carried: ChordMarker | null;
}

/**
 * HTML on top of the pattern canvas: the inline editor for a chord marker or a comment, and the
 * tooltip that shows comments and chords under the mouse.
 */
export function AnnotationOverlay({ pattern, first, rows, cw, trackX, top, hover, carried }: Props) {
  const edit = useAnnotationEdit();
  const LH = theme.lineHeight;
  const rowTop = (line: number) => top + Math.max(0, Math.min(rows - 1, line - first)) * LH;
  const areaLeft = (area: HoverTarget['area'], track: number | null) =>
    area === 'gutter' ? 2 : area === 'lane' || track === null ? LINE_NUMBER_CHARS * cw : trackX[track] * cw;

  if (edit && edit.patternId === pattern.id) {
    const left = edit.kind === 'chord' ? areaLeft('lane', null) : areaLeft('track', edit.track);
    return (
      <Floating className="annotation-edit" top={rowTop(edit.line) - 1} left={left}>
        <AnnotationInput key={`${edit.kind}:${edit.line}:${edit.kind === 'comment' ? edit.track : ''}`} edit={edit} pattern={pattern} />
      </Floating>
    );
  }

  if (!hover || hover.line < first || hover.line >= first + rows) return null;
  const text = tipText(pattern, hover, carried);
  if (!text) return null;
  // Below the row in the upper half of the grid, above it in the lower half.
  const below = hover.line - first < rows / 2;
  const y = below ? rowTop(hover.line) + LH + 2 : rowTop(hover.line) - 2;
  return (
    <Floating className={`annotation-tip${below ? '' : ' above'}`} top={y} left={areaLeft(hover.area, hover.track)}>
      {text}
    </Floating>
  );
}

/**
 * An absolutely placed box in the scrolling grid, kept inside the part that is scrolled into view,
 * so an editor or tooltip near the right edge never forces a horizontal scroll.
 */
function Floating({ className, top, left, children }: { className: string; top: number; left: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const view = el?.parentElement;
    if (!el || !view) return;
    const right = view.scrollLeft + view.clientWidth - 4;
    el.style.left = `${Math.max(view.scrollLeft + 4, Math.min(left, right - el.offsetWidth))}px`;
  });
  return (
    <div ref={ref} className={className} style={{ top }}>
      {children}
    </div>
  );
}

function tipText(pattern: Pattern, h: HoverTarget, carried: ChordMarker | null): string | null {
  if (h.area === 'lane') {
    let marker: ChordMarker | null = null;
    for (const m of pattern.chords) if (m.line <= h.line && m.line < pattern.lines) marker = m;
    const shown = marker ?? carried;
    if (!shown) return null;
    const from = marker ? `from line ${hex(marker.line, 2)}` : 'carried over from the previous pattern';
    const valid = parseChord(shown.symbol) !== null;
    return `${shown.symbol} · ${from}${valid ? '' : ' · not a chord symbol Krautrecker knows'}`;
  }
  const list = commentsAt(pattern, h.line, h.area === 'gutter' ? null : h.track);
  return list.length ? list.map((c) => c.text).join('\n') : null;
}

function AnnotationInput({ edit, pattern }: { edit: AnnotationEdit; pattern: Pattern }) {
  const initial =
    edit.kind === 'chord' ? (chordMarkerAt(pattern, edit.line)?.symbol ?? '') : (pattern.comments.find((c) => c.id === edit.commentId)?.text ?? '');
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // No scrolling on focus: Floating already placed the editor where it can be seen.
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) commitAnnotation(edit, text);
    else closeAnnotationEditor();
    focusPatternGrid();
  };

  const where = `${hex(edit.line, 2)}${edit.kind === 'comment' ? (edit.track === null ? ' line' : ` T${edit.track + 1}`) : ''}`;
  const invalid = edit.kind === 'chord' && text.trim() !== '' && !parseChord(text);
  return (
    <>
      <span className="annotation-label">
        {edit.kind === 'chord' ? 'Chord' : 'Comment'} {where}
      </span>
      <input
        ref={ref}
        className={`${edit.kind}${invalid ? ' invalid' : ''}`}
        value={text}
        placeholder={edit.kind === 'chord' ? 'Em, D/E, Cmaj7' : 'e.g. sounds off'}
        title={invalid ? 'Not a chord symbol Krautrecker knows; it is kept, but marked.' : 'Enter saves, Esc cancels, empty removes'}
        spellCheck={edit.kind === 'comment'}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
      />
    </>
  );
}
