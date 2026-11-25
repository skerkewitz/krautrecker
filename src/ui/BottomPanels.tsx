import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Diagnostic } from '../compiler/ir';
import { emptyCells, newPattern, newTrack } from '../model/defaults';
import { hex } from '../model/notes';
import type { Pattern } from '../model/types';
import { newId } from '../util/base64';
import { clonePattern } from './harmonyEdit';
import { loopAfterInsert, loopAfterRemove, loopAfterSwap } from './orderEdit';
import { store, useStore } from './store';
import { prepareCanvas, theme } from './theme';

// ------------------------------------------------------------------ order list

export function OrderList() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const names = new Map(project.patterns.map((p) => [p.id, p.name]));
  const select = (i: number) => store.setUi({ orderIndex: i, currentPatternId: project.order[i], selection: null });
  // Shown where the compiler puts it: invalid values clamp into the order list.
  const loop = Math.max(0, Math.min(project.order.length - 1, Math.round(project.loopOrderIndex) || 0));
  const setOrder = (order: string[], sel: number, loopOrderIndex: number) => {
    store.update((p) => ({ ...p, order, loopOrderIndex }));
    if (order[sel]) store.setUi({ orderIndex: sel, currentPatternId: order[sel] });
  };
  const move = (d: number) => {
    const i = ui.orderIndex;
    const j = i + d;
    if (i < 0 || j < 0 || j >= project.order.length) return;
    const order = project.order.slice();
    [order[i], order[j]] = [order[j], order[i]];
    setOrder(order, j, loopAfterSwap(loop, i, j));
  };
  const addPattern = (clone: boolean) => {
    const cur = project.patterns.find((p) => p.id === ui.currentPatternId);
    let pat: Pattern;
    if (clone && cur) pat = clonePattern(cur, newId('pat'), `${cur.name} copy`, () => newId('cmt'));
    else {
      const lines = cur?.lines ?? 64;
      const tracks = cur ? cur.tracks.map((t) => ({ ...newTrack(t.deviceId, t.noteColumns, lines), cells: emptyCells(lines, t.noteColumns) })) : [newTrack(null, 1, 64)];
      pat = newPattern(`Pattern ${project.patterns.length + 1}`, lines, tracks);
    }
    const at = ui.orderIndex + 1;
    store.update((p) => ({ ...p, patterns: [...p.patterns, pat], order: [...p.order.slice(0, at), pat.id, ...p.order.slice(at)], loopOrderIndex: loopAfterInsert(p.loopOrderIndex, at) }));
    store.setUi({ currentPatternId: pat.id, orderIndex: at });
  };
  const deletePattern = () => {
    const id = ui.currentPatternId;
    if (project.patterns.length <= 1) return;
    if (!confirm(`Delete pattern "${names.get(id)}" and remove it from the song?`)) return;
    store.update((p) => ({
      ...p,
      patterns: p.patterns.filter((x) => x.id !== id),
      order: p.order.filter((x) => x !== id),
      loopOrderIndex: loopAfterRemove(p.loopOrderIndex, p.order.map((x) => x !== id)),
    }));
  };

  return (
    <div className="order-list">
      <div className="order-items">
        {project.order.map((id, i) => (
          <div key={i} className={`order-item${i === ui.orderIndex ? ' active' : ''}`} onClick={() => select(i)}>
            <span className="idx">{hex(i, 2)}</span> {names.get(id) ?? '?'}
            {i === loop && (
              <span className="loop-mark" title="Loop point: after the last entry, the song continues here">
                ↻
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="button-row">
        <button
          title="Insert the current pattern after the selection"
          onClick={() => setOrder([...project.order.slice(0, ui.orderIndex + 1), ui.currentPatternId, ...project.order.slice(ui.orderIndex + 1)], ui.orderIndex + 1, loopAfterInsert(loop, ui.orderIndex + 1))}
        >
          + Insert
        </button>
        <button
          title="Remove the selected entry"
          disabled={ui.orderIndex < 0}
          onClick={() =>
            setOrder(
              project.order.filter((_, i) => i !== ui.orderIndex),
              Math.max(0, ui.orderIndex - 1),
              loopAfterRemove(loop, project.order.map((_, i) => i !== ui.orderIndex)),
            )
          }
        >
          − Remove
        </button>
        <button title="Move up" onClick={() => move(-1)}>
          ↑
        </button>
        <button title="Move down" onClick={() => move(1)}>
          ↓
        </button>
        <button
          title="Loop point: after the last entry, the song continues at the selected entry"
          disabled={ui.orderIndex < 0 || ui.orderIndex === loop}
          onClick={() => store.update((p) => ({ ...p, loopOrderIndex: ui.orderIndex }))}
        >
          ↻ Loop
        </button>
      </div>
      <div className="button-row">
        <button onClick={() => addPattern(false)}>New pattern</button>
        <button onClick={() => addPattern(true)}>Clone</button>
        <button className="danger" onClick={deletePattern}>
          Delete
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ voice meter

export function VoiceMeter() {
  const project = useStore((s) => s.project);
  const ui = useStore((s) => s.ui);
  const ir = useMemo(() => store.songIR(), [project]);
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 300, h: 80 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const available = 8 - ir.reservedVoices.length;
  const tpl = ir.timing.ticksPerLine;
  const playLine = ui.playing && ui.playMode === 'song' ? Math.floor(ui.playTick / tpl) : -1;
  const oi = ui.orderIndex >= 0 ? ui.orderIndex : project.order.indexOf(ui.currentPatternId);
  const cursorLine = ir.lines.findIndex((l) => l.orderIndex === oi && l.line === ui.cursor.line);
  const overflowLines = ir.voiceUsage.filter((u) => u.demand > available).length;
  const peak = ir.voiceUsage.reduce((m, u) => Math.max(m, u.demand), 0);

  useEffect(() => {
    const { w, h } = size;
    const ctx = prepareCanvas(canvasRef.current!, w, h);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);
    const n = ir.voiceUsage.length;
    if (n === 0) return;
    const bw = w / n;
    const unit = (h - 4) / 8;
    // Available voices line.
    ctx.fillStyle = '#3a4150';
    ctx.fillRect(0, h - available * unit - 1, w, 1);
    ir.voiceUsage.forEach((u, i) => {
      const x = i * bw;
      ctx.fillStyle = '#4fa36b';
      ctx.fillRect(x, h - u.used * unit, Math.max(1, bw - (bw > 3 ? 1 : 0)), u.used * unit);
      if (u.demand > available) {
        ctx.fillStyle = '#e5484d';
        ctx.fillRect(x, h - Math.min(8, u.demand) * unit, Math.max(1, bw - (bw > 3 ? 1 : 0)), (Math.min(8, u.demand) - u.used) * unit + 2);
      }
    });
    // Pattern boundaries.
    ctx.fillStyle = '#2c3240';
    ir.lines.forEach((l, i) => {
      if (l.line === 0) ctx.fillRect(i * bw, 0, 1, h);
    });
    if (cursorLine >= 0) {
      ctx.fillStyle = theme.cursorBox;
      ctx.fillRect(cursorLine * bw, 0, Math.max(1, bw), h);
    }
    if (playLine >= 0) {
      ctx.fillStyle = '#7ee08a';
      ctx.fillRect(playLine * bw, 0, 2, h);
    }
  });

  const onClick = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const li = Math.floor(((e.clientX - rect.left) / size.w) * ir.voiceUsage.length);
    const info = ir.lines[li];
    if (info) store.setUi({ currentPatternId: info.patternId, orderIndex: info.orderIndex, cursor: { ...store.getState().ui.cursor, line: info.line }, selection: null });
  };

  return (
    <div className="pane voice-meter">
      <div className="pane-summary">
        <span className="dim">{available} voices available · peak demand {peak}</span>
        {overflowLines > 0 && <span className="bad"> · over the limit on {overflowLines} lines</span>}
      </div>
      <div className="meter-canvas" ref={ref}>
        <canvas ref={canvasRef} onClick={onClick} title="Voices used per song line (green). Red: notes wanted more voices than available. Click to jump." />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ ARAM meter

const ARAM_PARTS = [
  { key: 'driver', label: 'Driver (assumed)', color: '#6c7a96' },
  { key: 'directory', label: 'Sample directory', color: '#a0a8b8' },
  { key: 'samplesTotal', label: 'BRR samples', color: '#4fa36b' },
  { key: 'echo', label: 'Echo buffer', color: '#c39bff' },
  { key: 'song', label: 'Song data (estimate)', color: '#ffb86b' },
] as const;

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function AramMeter() {
  const project = useStore((s) => s.project);
  const aram = useMemo(() => store.songIR().aram, [project]);
  const over = aram.total > aram.capacity;
  const scale = Math.max(aram.capacity, aram.total);
  return (
    <div className="pane aram">
      <div className="pane-summary">
        <span className={over ? 'bad' : 'dim'}>{kb(aram.total)} of 64 KB used (estimate)</span>
      </div>
      <div className="aram-bar">
        {ARAM_PARTS.map((p) => (
          <span key={p.key} style={{ width: `${(aram[p.key] / scale) * 100}%`, background: p.color }} title={`${p.label}: ${aram[p.key]} bytes`} />
        ))}
        {over && <span className="aram-limit" style={{ left: `${(aram.capacity / scale) * 100}%` }} />}
      </div>
      <div className="aram-legend">
        {ARAM_PARTS.map((p) => (
          <div key={p.key}>
            <i style={{ background: p.color }} />
            {p.label} <b>{kb(aram[p.key])}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ diagnostics

export function Diagnostics() {
  const project = useStore((s) => s.project);
  const diags = useMemo(() => store.songIR().diagnostics, [project]);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diags) counts[d.severity]++;
  const jump = (d: Diagnostic) => {
    if (!d.source) return;
    store.setUi({
      currentPatternId: d.source.patternId,
      orderIndex: d.source.orderIndex,
      cursor: { track: d.source.track, column: d.source.column, field: 0, line: d.source.line },
      selection: null,
    });
  };
  return (
    <div className="pane diagnostics">
      <div className="pane-summary">
        <span className="dim">
          {counts.error} errors · {counts.warning} warnings · {counts.info} notes
        </span>
      </div>
      <div className="diag-list">
        {diags.length === 0 && <div className="dim">Everything fits on the hardware.</div>}
        {diags.slice(0, 300).map((d, i) => (
          <div key={i} className={`diag ${d.severity}${d.source ? ' link' : ''}`} onClick={() => jump(d)}>
            {d.source && <span className="where">{`${hex(d.source.orderIndex, 2)}:${hex(d.source.line, 2)} T${d.source.track + 1}`}</span>}
            {d.message}
          </div>
        ))}
        {diags.length > 300 && <div className="dim">…and {diags.length - 300} more.</div>}
      </div>
    </div>
  );
}
