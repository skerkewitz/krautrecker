import { parseChord } from '../model/harmony';
import type { ChordMarker, Pattern } from '../model/types';
import { theme } from './theme';

/**
 * Canvas drawing of chord markers and comment marks in the pattern grid. The left gutter holds the
 * line numbers and, right of them, the chord lane.
 */

export const LINE_NUMBER_CHARS = 4;
export const CHORD_LANE_CHARS = 7;
/** Longest symbol shown whole in the lane; longer ones are cut with an ellipsis. */
const LANE_TEXT = CHORD_LANE_CHARS - 1;

export function laneText(symbol: string): string {
  return symbol.length > LANE_TEXT ? `${symbol.slice(0, LANE_TEXT - 1)}…` : symbol;
}

export interface AnnotationView {
  pat: Pattern;
  first: number;
  rows: number;
  cw: number;
  /** Track start and end (separator) in chars. */
  trackX: number[];
  trackEnd: number[];
  /** Marker carried into this pattern from earlier patterns in song order. */
  carried: ChordMarker | null;
}

export function drawAnnotations(ctx: CanvasRenderingContext2D, v: AnnotationView): void {
  drawChordLane(ctx, v);
  drawCommentMarks(ctx, v);
}

function drawChordLane(ctx: CanvasRenderingContext2D, v: AnnotationView): void {
  const { pat, first, rows, cw } = v;
  const LH = theme.lineHeight;
  const x0 = LINE_NUMBER_CHARS * cw;
  const markers = pat.chords.filter((m) => m.line < pat.lines);
  // Each marker holds until the next one; a marker carried in from earlier patterns holds from line 0.
  const spans: { from: number; to: number; marker: ChordMarker; carried: boolean }[] = [];
  if (v.carried && markers[0]?.line !== 0) spans.push({ from: 0, to: (markers[0]?.line ?? pat.lines) - 1, marker: v.carried, carried: true });
  markers.forEach((m, i) => spans.push({ from: m.line, to: (markers[i + 1]?.line ?? pat.lines) - 1, marker: m, carried: false }));

  for (const span of spans) {
    const valid = parseChord(span.marker.symbol) !== null;
    const lo = Math.max(span.from, first);
    const hi = Math.min(span.to, first + rows - 1);
    if (lo <= hi) {
      // The hold bar: a thin line beside the lane, starting just below the marker's own row.
      const top = (lo - first) * LH + (lo === span.from ? 3 : 0);
      const bottom = (hi - first + 1) * LH - (hi === span.to ? 2 : 0);
      ctx.fillStyle = valid ? theme.chordHold : theme.chordInvalid;
      ctx.globalAlpha = valid ? 1 : 0.4;
      ctx.fillRect(x0, top, 2, bottom - top);
      ctx.globalAlpha = 1;
    }
    if (span.from < first || span.from >= first + rows) continue;
    const y = (span.from - first) * LH;
    const cy = y + LH / 2 + 1;
    const text = laneText(span.marker.symbol);
    ctx.fillStyle = span.carried ? theme.gutter : valid ? theme.chord : theme.chordInvalid;
    ctx.fillText(text, x0 + 0.6 * cw, cy);
    if (!valid && !span.carried) {
      // Unknown symbols stay in the project but are underlined, like a spelling mistake.
      ctx.fillRect(x0 + 0.6 * cw, y + LH - 3, text.length * cw, 1);
    }
  }
}

function drawCommentMarks(ctx: CanvasRenderingContext2D, v: AnnotationView): void {
  const { pat, first, rows, cw } = v;
  const LH = theme.lineHeight;
  ctx.fillStyle = theme.comment;
  for (const c of pat.comments) {
    if (c.line < first || c.line >= first + rows) continue;
    if (c.track !== null && !pat.tracks[c.track]) continue;
    const y = (c.line - first) * LH;
    // A corner triangle, as spreadsheets mark commented cells: at the right edge of the track,
    // or of the line number for a comment on the whole line.
    const right = c.track === null ? LINE_NUMBER_CHARS * cw - 3 : v.trackEnd[c.track] * cw - cw / 2 - 1;
    ctx.beginPath();
    ctx.moveTo(right - 6, y + 1);
    ctx.lineTo(right, y + 1);
    ctx.lineTo(right, y + 7);
    ctx.closePath();
    ctx.fill();
  }
}
