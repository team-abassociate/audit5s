import { formatScore } from '@audit5s/domain';

/**
 * The geometry and wording rules under Kaizen's phone charts (`kaizen-charts.tsx`), apart
 * from React Native so they can be tested — the same split as `theme-choice.ts`.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

/** "Oct 26" from "2026-10": en-IN month abbreviations, as every date in the app. */
export function monthLabel(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  return `${MONTHS[Number(month) - 1] ?? month} ${year?.slice(2)}`;
}

/** One decimal, truncated, never rounded up (R-45); no submissions is "—", never 0 %. */
export function ratio(pct: number | null): string {
  return pct === null ? '—' : `${formatScore(pct)}%`;
}

/** Ink or tile, whichever has the higher contrast on `fill` (`#RRGGBB`) in this theme. */
export function textOn(fill: string, ink: string, tile: string): string {
  return contrast(fill, ink) >= contrast(fill, tile) ? ink : tile;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
