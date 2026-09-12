import { bandFor } from '@audit5s/domain';
import type { ResponseValue } from '@audit5s/contracts';

/**
 * Score band → design-system band, in one place for the whole app.
 *
 * `packages/domain` owns the scale (R-6b: four bands at 90 / 75 / 60) and is the only file
 * in the codebase allowed to name a colour. The design system carries three colour pairs,
 * so the two upper bands share `--ok` and the band **label** keeps the four apart — status
 * reads without colour either way (GEMBA-BOARD.md non-negotiable 8).
 *
 * Everything here returns a class, never a value: a hex literal in a component — including
 * one smuggled in through an inline `style` — is a rejectable UI diff.
 */
export type Band = 'ok' | 'warn' | 'crit' | 'none';

export function bandOf(percentage: number | null): Band {
  const band = bandFor(percentage);
  if (!band) return 'none';
  switch (band.token) {
    case 'band-outstanding':
    case 'band-on-track':
      return 'ok';
    case 'band-improving':
      return 'warn';
    default:
      return 'crit';
  }
}

/** The R-6b label, so all four bands are readable without colour. */
export function bandLabel(percentage: number | null): string {
  return bandFor(percentage)?.label ?? 'N/A';
}

/** Text colour for a figure, as a token class. */
export function bandTextClass(percentage: number | null): string {
  return `gb-text-${bandOf(percentage)}`;
}

/** The same mapping for a single answer (`RESPONSE_TOKENS` in `packages/domain`). */
export function responseTextClass(value: ResponseValue): string {
  if (value === 'SCORE_2') return 'gb-text-ok';
  if (value === 'SCORE_1') return 'gb-text-warn';
  if (value === 'SCORE_0') return 'gb-text-crit';
  return 'gb-text-none';
}
