import type { SSection, ResponseValue } from '@audit5s/contracts';
import { RESPONSE_TOKENS } from './rating-scale';

/**
 * The `s_section → label` mapping (HANDOFF.md §3.4). These strings are exactly what the
 * workbook prints and exactly what the reports must render — including the en dash.
 */
export const S_SECTION_LABELS: Readonly<Record<SSection, string>> = {
  S1_SORT: '1S – SEIRI (SORT)',
  S2_SET_IN_ORDER: '2S – SEITON (SET IN ORDER)',
  S3_SHINE: '3S – SEISO (SHINE)',
  S4_STANDARDIZE: '4S – SEIKETSU (STANDARDIZE)',
  S5_SUSTAIN: '5S – SHITSUKE (SUSTAIN)',
} as const;

/** Short axis labels for the 5S performance web. */
export const S_SECTION_SHORT_LABELS: Readonly<Record<SSection, string>> = {
  S1_SORT: '1S',
  S2_SET_IN_ORDER: '2S',
  S3_SHINE: '3S',
  S4_STANDARDIZE: '4S',
  S5_SUSTAIN: '5S',
} as const;

/** Workbook and report order. */
export const S_SECTION_ORDER: readonly SSection[] = [
  'S1_SORT',
  'S2_SET_IN_ORDER',
  'S3_SHINE',
  'S4_STANDARDIZE',
  'S5_SUSTAIN',
] as const;

/** Confirmed against the real workbook (HANDOFF.md §3.1): 5 sections × 10 = 50. */
export const QUESTIONS_PER_SECTION = 10;
export const TOTAL_QUESTIONS = S_SECTION_ORDER.length * QUESTIONS_PER_SECTION;
export const MAX_MARKS_PER_QUESTION = 2;

export function sectionLabel(section: SSection): string {
  return S_SECTION_LABELS[section];
}

/**
 * The numeric weight of a response. `NA` is `null`, not `0` — it is excluded from the
 * denominator rather than scored as a failure (D3/D4). Implemented once here so the server
 * and the device cannot disagree.
 */
export function responseMarks(value: ResponseValue): number | null {
  return RESPONSE_TOKENS[value]?.marks ?? null;
}
