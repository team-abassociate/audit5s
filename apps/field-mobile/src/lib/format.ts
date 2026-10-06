/**
 * Dates and figures, formatted once for every screen.
 *
 * Dates come from `@audit5s/domain`, the one formatter the web portal and the reports use
 * too: "30 Sept 2026, 2:05 PM", 12-hour, always India Standard Time (proposed R-45(b)).
 * Scores show one decimal in tiles and charts (GEMBA-BOARD.md §3), truncated so the number never
 * rises past the band line beside it (D15).
 */
import { formatScore } from '@audit5s/domain';

export { formatDate, formatDateTime } from '@audit5s/domain';

/** `null` is "nothing applicable" (D4), never zero. */
export const formatPct = (pct: number | null): string => (pct === null ? 'N/A' : `${formatScore(pct)}%`);
