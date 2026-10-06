import type { ReactNode } from 'react';
import type { TabId } from './catalog.ts';
import type { WallsMode } from '../../store.ts';

const Svg = ({ children, size = 20 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export function TabIcon({ tab }: { tab: TabId }) {
  switch (tab) {
    case 'desks':
      return (
        <Svg>
          <rect x="7" y="3.5" width="10" height="7" rx="1" />
          <path d="M12 10.5v2.5M3 13h18M5 13v7M19 13v7" />
        </Svg>
      );
    case 'seating':
      return (
        <Svg>
          <path d="M7 4h10v8H7zM5 12h14v4H5zM7 16v4M17 16v4" />
        </Svg>
      );
    case 'tables':
      return (
        <Svg>
          <rect x="3" y="8" width="18" height="3" rx="1" />
          <path d="M6 11v8M18 11v8" />
        </Svg>
      );
    case 'decor':
      return (
        <Svg>
          <path d="M8 4h8l2 8H6zM12 12v6M8.5 20h7" />
        </Svg>
      );
    case 'plants':
      return (
        <Svg>
          <path d="M8 14h8l-1 6H9zM12 14c0-4-1-6-5-7 0 4 1 6 5 7zM12 14c0-3 1-6 5-7 0 3-1 6-5 7z" />
        </Svg>
      );
    case 'storage':
      return (
        <Svg>
          <rect x="5" y="3.5" width="14" height="17" rx="1" />
          <path d="M5 9.2h14M5 14.8h14" />
        </Svg>
      );
    case 'stairs':
      return (
        <Svg>
          <path d="M4 20h5v-4h5v-4h5V8" />
          <path d="M4 20h16" />
        </Svg>
      );
    case 'walls':
      return (
        <Svg>
          <rect x="3.5" y="5" width="17" height="14" rx="1" />
          <path d="M3.5 9.7h17M3.5 14.3h17M9 5v4.7M15 9.7v4.6M9 14.3V19" />
        </Svg>
      );
    case 'floors':
      return (
        <Svg>
          <path d="M3 9l9-4 9 4-9 4zM3 9v4l9 4 9-4V9M12 13v4" />
        </Svg>
      );
    case 'openings':
      return (
        <Svg>
          <path d="M6 20V5a1 1 0 011-1h10a1 1 0 011 1v15M4 20h16" />
          <circle cx="14.8" cy="12.3" r="0.9" fill="currentColor" />
        </Svg>
      );
  }
}

export function ToolIcon({ icon }: { icon: 'wall' | 'room' | 'door' | 'window' | 'arch' }) {
  const s = 44;
  switch (icon) {
    case 'wall':
      return (
        <Svg size={s}>
          <path d="M3 17l12-6V5L3 11zM15 11l6 3v6l-6-3z" />
          <path d="M3 11v6l12 6v-6" />
        </Svg>
      );
    case 'room':
      return (
        <Svg size={s}>
          <path d="M3 9l9-4 9 4v8l-9 4-9-4z" />
          <path d="M3 9l9 4 9-4M12 13v8" />
        </Svg>
      );
    case 'door':
      return (
        <Svg size={s}>
          <path d="M4 21V7l8-4 8 4v14M9 21v-8a3 3 0 016 0v8" />
          <circle cx="13.3" cy="16" r="0.8" fill="currentColor" />
        </Svg>
      );
    case 'window':
      return (
        <Svg size={s}>
          <rect x="5" y="4" width="14" height="16" rx="1" />
          <path d="M12 4v16M5 12h14" />
        </Svg>
      );
    case 'arch':
      return (
        <Svg size={s}>
          <path d="M5 21V11a7 7 0 0114 0v10M3 21h18" />
        </Svg>
      );
  }
}

export const WALL_MODES: readonly { mode: WallsMode; label: string }[] = [
  { mode: 'up', label: 'Walls up' },
  { mode: 'cutaway', label: 'Cutaway' },
  { mode: 'down', label: 'Walls down' },
];

export function WallsIcon({ mode }: { mode: WallsMode }) {
  const top = mode === 'up' ? 6 : mode === 'cutaway' ? 11 : 15.5;
  return (
    <Svg>
      <path d="M3 19h18" />
      <path d={`M4.5 19V${top}h6V19`} fill="currentColor" fillOpacity="0.18" />
      <path d={`M13.5 19v-${mode === 'down' ? 3 : 8}h6V19`} fill="currentColor" fillOpacity="0.18" />
      {mode === 'cutaway' && <path d="M13.5 11l6 -3" />}
    </Svg>
  );
}

export const Undo = () => (
  <Svg size={18}>
    <path d="M9 14L4 9l5-5M4 9h9a6 6 0 010 12h-3" />
  </Svg>
);
export const Redo = () => (
  <Svg size={18}>
    <path d="M15 14l5-5-5-5M20 9h-9a6 6 0 000 12h3" />
  </Svg>
);
export const Search = () => (
  <Svg size={16}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </Svg>
);
