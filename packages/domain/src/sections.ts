import type { SSection, ResponseValue } from '@audit5s/contracts';
import { RESPONSE_TOKENS } from './rating-scale';

/**
 * The `s_section → label` mapping. These strings are exactly what the
 * workbook prints and exactly what the reports must render — including the en dash.
 */
export const S_SECTION_LABELS: Readonly<Record<SSection, string>> = {
  S1_SORT: '1S – SEIRI (SORT)',
  S2_SET_IN_ORDER: '2S – SEITON (SET IN ORDER)',
  S3_SHINE: '3S – SEISO (SHINE)',
  S4_STANDARDIZE: '4S – SEIKETSU (STANDARDIZE)',
  S5_SUSTAIN: '5S – SHITSUKE (SUSTAIN)',
  SAFETY: 'SAFETY',
} as const;

/** Short axis labels for the performance web. */
export const S_SECTION_SHORT_LABELS: Readonly<Record<SSection, string>> = {
  S1_SORT: '1S',
  S2_SET_IN_ORDER: '2S',
  S3_SHINE: '3S',
  S4_STANDARDIZE: '4S',
  S5_SUSTAIN: '5S',
  SAFETY: 'Safety',
} as const;

/** Workbook and report order. */
export const S_SECTION_ORDER: readonly SSection[] = [
  'S1_SORT',
  'S2_SET_IN_ORDER',
  'S3_SHINE',
  'S4_STANDARDIZE',
  'S5_SUSTAIN',
  'SAFETY',
] as const;

/** Any number of questions per section, including none (owner, 2026-11-16). */
export const MAX_MARKS_PER_QUESTION = 2;

/**
 * Whether a section belongs in a breakdown. 1S–5S always do (an all-NA S still shows, as
 * excluded); Safety only where its checklist asked it, so an audit taken before Safety
 * existed shows no empty Safety row.
 */
export function isSectionShown(section: SSection, asked: boolean): boolean {
  return section !== 'SAFETY' || asked;
}

/** The sections, in order, that appear in any of these breakdowns. */
export function sectionsPresent(
  breakdowns: Iterable<readonly { section: SSection }[] | undefined>,
): SSection[] {
  const seen = new Set<SSection>();
  for (const list of breakdowns) for (const entry of list ?? []) seen.add(entry.section);
  return S_SECTION_ORDER.filter((section) => seen.has(section));
}

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
