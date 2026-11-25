/** Colours and metrics shared by the canvas views (they cannot read CSS variables cheaply). */
export const theme = {
  font: '13px "JetBrains Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
  lineHeight: 17,
  bg: '#14161b',
  bgBeat: '#1a1d24',
  bgBar: '#20242d',
  rowCursor: '#2b3242',
  rowCursorEdit: '#3a2630',
  rowPlay: '#1f3a2f',
  selection: 'rgba(110, 160, 255, 0.25)',
  cursorBox: '#ffd166',
  gutter: '#5b6272',
  gutterBeat: '#9aa3b5',
  empty: '#3a404c',
  note: '#e8ecf3',
  noteOff: '#ff8fa3',
  vol: '#7ee08a',
  pan: '#c39bff',
  delay: '#8fb8ff',
  fx: '#ffb86b',
  separator: '#2a2f3a',
  warn: 'rgba(255, 170, 60, 0.35)',
  error: 'rgba(255, 80, 90, 0.45)',
  voiceBusy: '#1c2430',
  reserved: '#24181c',
};

let charWidth = 0;
export function measureChar(ctx: CanvasRenderingContext2D): number {
  if (!charWidth) {
    ctx.font = theme.font;
    charWidth = Math.ceil(ctx.measureText('0').width * 100) / 100;
  }
  return charWidth;
}

/** Sizes a canvas for the device pixel ratio and returns a context scaled to CSS pixels. */
export function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = theme.font;
  ctx.textBaseline = 'middle';
  return ctx;
}
