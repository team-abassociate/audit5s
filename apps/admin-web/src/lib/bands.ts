import { bandFor } from '@audit5s/domain';
import type { ResponseValue } from '@audit5s/contracts';

/**
 * Score band → design-system band, in one place for the whole app.
 *
 * `packages/domain` owns the scale (R-6b: four bands at 90 / 75 / 60), and Ledger draws all
 * four: Outstanding green, On Track blue, Improving yellow, Needs Support red. The band
 * **label** is shown beside the colour, so status reads without it (LEDGER.md rule 3).
 *
 * Everything here returns a class or a name, never a value: a hex literal in a component —
 * including one smuggled in through an inline `style` — is a rejectable UI diff.
 */
export type Band = 'outstanding' | 'on-track' | 'improving' | 'needs-support' | 'none';

/** A status that is not a score (overdue, waiting, approved …), drawn in a band's colour. */
export type Tone = 'ok' | 'warn' | 'crit' | 'none';

export function bandOf(percentage: number | null): Band {
  const band = bandFor(percentage);
  return band ? (band.token.slice('band-'.length) as Band) : 'none';
}

/** The R-6b label, so all four bands are readable without colour. */
export function bandLabel(percentage: number | null): string {
  return bandFor(percentage)?.label ?? 'N/A';
}

/** Text colour for a figure, as a token class. */
export function bandTextClass(percentage: number | null): string {
  return `gb-text-${bandOf(percentage)}`;
}

/** The custom property of a band's solid colour, for a chart that needs a value (`useToken`). */
export function bandToken(band: Band): string {
  return band === 'none' ? '--rule-soft' : `--band-${band}`;
}

/** The same mapping for a single answer (`RESPONSE_TOKENS` in `packages/domain`). */
export function responseTextClass(value: ResponseValue): string {
  if (value === 'SCORE_2') return 'gb-text-outstanding';
  if (value === 'SCORE_1') return 'gb-text-improving';
  if (value === 'SCORE_0') return 'gb-text-needs-support';
  return 'gb-text-none';
}
