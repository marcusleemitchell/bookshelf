/** Inline SVG icons (decorative: always paired with visible or sr-only text). */
import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const TodayIcon = () => (
  <Svg>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2.5 2.5M9 2h6" />
  </Svg>
);

export const LibraryIcon = () => (
  <Svg>
    <path d="M4 4h4v16H4zM10 4h4v16h-4zM16.5 4.5l3.5 1-3.8 14.5-3.5-1" />
  </Svg>
);

export const CalendarIcon = () => (
  <Svg>
    <rect x="3.5" y="5" width="17" height="15" rx="2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Svg>
);

export const StatsIcon = () => (
  <Svg>
    <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />
  </Svg>
);

export const SettingsIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M4.2 6.2l2.1 2.1M17.7 15.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 17.8l2.1-2.1M17.7 8.3l2.1-2.1" />
  </Svg>
);

export const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const BackIcon = () => (
  <Svg>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);

export const ChevronRightIcon = () => (
  <Svg>
    <path d="M9 5l7 7-7 7" />
  </Svg>
);

export const CameraIcon = () => (
  <Svg>
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </Svg>
);
