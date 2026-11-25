/**
 * Workbench layout, modelled on VS Code: an activity bar with a left sidebar, a bottom panel and a
 * right sidebar, each of which can be shown or hidden and resized. The layout is a user preference,
 * not part of the project, so it lives in localStorage rather than in the project file.
 */

export type LeftView = 'devices' | 'samples' | 'song' | 'hardware';
export type BottomTab = 'voices' | 'aram' | 'diagnostics';

export interface Layout {
  leftView: LeftView;
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
}

export const DEFAULT_LAYOUT: Layout = {
  leftView: 'devices',
  leftOpen: true,
  rightOpen: true,
  bottomOpen: true,
  bottomTab: 'voices',
  leftWidth: 320,
  // Wide enough for all eight IR voice columns.
  rightWidth: 610,
  bottomHeight: 200,
};

/** Size limits for the resizable areas, in CSS pixels. */
export const LIMITS = {
  leftWidth: [220, 600],
  rightWidth: [260, 900],
  bottomHeight: [100, 600],
} as const;

const KEY = 'krautrecker.layout';

export function loadLayout(): Layout {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_LAYOUT };
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<Layout>) } : { ...DEFAULT_LAYOUT };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Storage full or disabled: the layout just is not remembered.
  }
}

export function clampSize(key: keyof typeof LIMITS, value: number): number {
  const [lo, hi] = LIMITS[key];
  return Math.round(Math.max(lo, Math.min(hi, value)));
}
