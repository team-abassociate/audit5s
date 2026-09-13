/**
 * Dates and figures, formatted once for every screen.
 *
 * `en-IN` because the plants are in India: day before month, and a 24-hour clock that a shift
 * log already uses. Scores show one decimal in tiles and charts (GEMBA-BOARD.md §3).
 */
const DATE = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

type When = string | number | Date;

export const formatDate = (value: When): string => DATE.format(new Date(value));
export const formatDateTime = (value: When): string => DATE_TIME.format(new Date(value));

/** `null` is "nothing applicable" (D4), never zero. */
export const formatPct = (pct: number | null): string => (pct === null ? 'N/A' : `${pct.toFixed(1)}%`);
