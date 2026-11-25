import type { ReactNode } from 'react';

/** Line icons in the style of VS Code's codicons: 24x24, stroke in the current text colour. */

function Icon({ children, size = 24 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const MenuIcon = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

/** Devices: a small piano keyboard. */
export const DevicesIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="1.5" />
    <path d="M8 19v-5M12 19v-5M16 19v-5" />
    <path d="M7 5v7h2V5M11 5v7h2V5M15 5v7h2V5" fill="currentColor" strokeWidth={1} />
  </Icon>
);

/** Samples: a waveform. */
export const SamplesIcon = () => (
  <Icon>
    <path d="M2 12h2l2-6 3 12 3-15 3 15 2-9 1.5 3H22" />
  </Icon>
);

/** Song: the order list. */
export const SongIcon = () => (
  <Icon>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4 4.5l2.5 1.5L4 7.5zM4 10.5l2.5 1.5L4 13.5zM4 16.5l2.5 1.5L4 19.5z" fill="currentColor" strokeWidth={1} />
  </Icon>
);

/** Hardware: a chip. */
export const HardwareIcon = () => (
  <Icon>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
    <rect x="9.5" y="9.5" width="5" height="5" />
    <path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3" />
  </Icon>
);

/**
 * Layout toggles as in VS Code's title bar: an outlined window whose left, bottom or right part is
 * filled while that area is visible.
 */
export function LayoutIcon({ part, on }: { part: 'left' | 'bottom' | 'right'; on: boolean }) {
  const fill = { left: 'M3.5 4.5h5v15h-5z', bottom: 'M3.5 13.5h17v6h-17z', right: 'M15.5 4.5h5v15h-5z' }[part];
  const line = { left: 'M8.5 4.5v15', bottom: 'M3.5 13.5h17', right: 'M15.5 4.5v15' }[part];
  return (
    <Icon size={20}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      {on ? <path d={fill} fill="currentColor" stroke="none" /> : <path d={line} />}
    </Icon>
  );
}

export const CloseIcon = () => (
  <Icon size={16}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
