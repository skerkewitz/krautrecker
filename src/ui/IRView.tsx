import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IR, SourceRef, VoiceEvent } from '../compiler/ir';
import { hex, noteName } from '../model/notes';
import { store, useStore } from './store';
import { measureChar, prepareCanvas, theme } from './theme';

const GUTTER = 6;
const VOICE_CHARS = 9;

interface CellInfo {
  text: string;
  color: string;
  mark: 'warn' | 'error' | null;
  source: SourceRef | null;
}

/** Summarises each voice lane per song line: what a tracker-style IR row shows. */
function summarise(ir: IR): CellInfo[][] {
  const tpl = ir.timing.ticksPerLine;
  const rows: CellInfo[][] = ir.lines.map(() => Array.from({ length: 8 }, () => ({ text: '', color: theme.empty, mark: null, source: null })));
  ir.voices.forEach((lane, v) => {
    const byLine = new Map<number, VoiceEvent[]>();
    for (const e of lane) {
      const l = Math.floor(e.tick / tpl);
      let arr = byLine.get(l);
      if (!arr) byLine.set(l, (arr = []));
      arr.push(e);
    }
    for (const [l, evs] of byLine) {
      const row = rows[l];
      if (!row) continue;
      const on = evs.find((e) => e.type === 'keyOn');
      const pitch = evs.some((e) => e.type === 'setPitch');
      const vol = evs.some((e) => e.type === 'setVolume');
      const off = evs.some((e) => e.type === 'keyOff');
      const cell = row[v];
      if (on && on.type === 'keyOn') {
        const more = evs.filter((e) => e.type === 'keyOn').length > 1 ? '+' : ' ';
        cell.text = `${noteName(on.note)} ${hex(on.sampleSlot, 2)}${more}${pitch ? '~' : ' '}`;
        cell.color = theme.note;
        cell.mark = on.stolen ? 'error' : on.clamped ? 'warn' : null;
        cell.source = on.source;
      } else if (off) {
        cell.text = `off   ${pitch ? '~' : ' '}`;
        cell.color = theme.noteOff;
        cell.source = evs[0].source;
      } else {
        cell.text = `      ${pitch ? '~' : ' '}${vol ? 'v' : ' '}`;
        cell.color = evs.every((e) => e.auto) ? theme.gutter : theme.fx;
        cell.source = evs[0].source;
      }
      if (evs.some((e) => e.type === 'setPitch' && e.clamped)) cell.mark = cell.mark ?? 'warn';
    }
  });
  return rows;
}

export function IRView() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const ir = useMemo(() => store.songIR(), [project]);
  const rows = useMemo(() => summarise(ir), [ir]);
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 300, h: 300 });
  const [cw, setCw] = useState(8);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setCw(measureChar(canvasRef.current!.getContext('2d')!));
    return () => ro.disconnect();
  }, []);

  const tpl = ir.timing.ticksPerLine;
  // Song line in focus: play position while playing the song, else the cursor's line in the song.
  let focus = -1;
  if (ui.playing && ui.playMode === 'song') focus = Math.floor(ui.playTick / tpl);
  else {
    const oi = ui.orderIndex >= 0 ? ui.orderIndex : project.order.indexOf(ui.currentPatternId);
    focus = ir.lines.findIndex((l) => l.orderIndex === oi && l.line === ui.cursor.line);
  }
  const w = Math.max(size.w, (GUTTER + VOICE_CHARS * 8) * cw + 6);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = prepareCanvas(canvas, w, size.h);
    const LH = theme.lineHeight;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, size.h);
    for (const v of ir.reservedVoices) {
      ctx.fillStyle = theme.reserved;
      ctx.fillRect((GUTTER + v * VOICE_CHARS) * cw - 3, 0, VOICE_CHARS * cw, size.h);
    }
    const nrows = Math.floor(size.h / LH);
    const first = Math.max(0, focus) - Math.floor(nrows / 2);
    for (let r = 0; r < nrows; r++) {
      const li = first + r;
      const info = ir.lines[li];
      if (!info) continue;
      const y = r * LH;
      const cy = y + LH / 2 + 1;
      if (li === focus) {
        ctx.fillStyle = ui.playing ? theme.rowPlay : theme.rowCursor;
        ctx.fillRect(0, y, w, LH);
      } else if (info.line % (project.timing.linesPerBeat * 4) === 0) {
        ctx.fillStyle = theme.bgBar;
        ctx.fillRect(0, y, w, LH);
      }
      ctx.fillStyle = info.line === 0 ? theme.gutterBeat : theme.gutter;
      ctx.fillText(`${hex(info.orderIndex, 2)}:${hex(info.line, 2)}`, 2, cy);
      rows[li].forEach((cell, v) => {
        const x = (GUTTER + v * VOICE_CHARS) * cw;
        if (cell.mark) {
          ctx.fillStyle = cell.mark === 'error' ? theme.error : theme.warn;
          ctx.fillRect(x - 2, y + 1, 6 * cw + 4, LH - 2);
        }
        ctx.fillStyle = cell.text ? cell.color : theme.empty;
        ctx.fillText(cell.text || '·', x, cy);
      });
    }
  });

  const onClick = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const nrows = Math.floor(size.h / theme.lineHeight);
    const li = Math.max(0, focus) - Math.floor(nrows / 2) + Math.floor((e.clientY - rect.top) / theme.lineHeight);
    const v = Math.floor(((e.clientX - rect.left) / cw - GUTTER) / VOICE_CHARS);
    const src = rows[li]?.[v]?.source;
    if (src) {
      store.setUi({
        currentPatternId: src.patternId,
        orderIndex: src.orderIndex,
        cursor: { track: src.track, column: src.column, field: 0, line: src.line },
        selection: null,
      });
    }
  };

  return (
    <div className="ir-view">
      <div className="ir-header" style={{ width: w }}>
        <span style={{ width: GUTTER * cw }} className="ir-title" title="Order:line">
          IR
        </span>
        {Array.from({ length: 8 }, (_, v) => (
          <span key={v} className="ir-voice" style={{ width: VOICE_CHARS * cw }}>
            {ir.reservedVoices.includes(v) ? `V${v} SFX` : `V${v}`}
            <span className="level">
              <span style={{ width: `${Math.min(100, (ui.levels[v] / 0x7ff) * 100)}%` }} />
            </span>
          </span>
        ))}
      </div>
      <div className="ir-body" ref={ref}>
        <canvas ref={canvasRef} onClick={onClick} title="Compiled voice data (read-only). Click an event to jump to the note that caused it." />
      </div>
    </div>
  );
}
