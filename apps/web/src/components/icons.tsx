import type { ReactNode } from 'react';

/**
 * Nav glyphs are inline so the PWA adds no icon dependency. They are decorative:
 * every link carries its own text label.
 */

export type IconName = 'home' | 'poultry' | 'health' | 'store' | 'sales' | 'finance';

const GLYPHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M4 10.7 12 4l8 6.7" />
      <path d="M6 9.8V20h12V9.8" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  poultry: <path d="M12 3.5c3.6 0 6 3.1 6 7s-2.4 7-6 7-6-3.1-6-7 2.4-7 6-7Z" />,
  health: <path d="M3 12h3.5L9 6.5 12.5 18l3-9 1.8 3H21" />,
  store: (
    <>
      <path d="M4 9.5 5.5 5h13L20 9.5" />
      <path d="M4 9.5h16V19H4Z" />
      <path d="M9.5 13h5" />
    </>
  ),
  sales: (
    <>
      <path d="M20 12.5 12.5 20 4 11.5V4h7.5L20 12.5Z" />
      <circle cx="8.2" cy="8.2" r="1.3" />
    </>
  ),
  finance: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="2.5" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M6.6 12h.01M17.4 12h.01" />
    </>
  ),
};

export function NavIcon({ name }: { name: IconName }) {
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
      {GLYPHS[name]}
    </svg>
  );
}
