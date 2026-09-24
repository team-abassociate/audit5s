/**
 * Rating scale, response tokens and brand tokens (DECISIONS.md R-6b / R-6c).
 *
 * Every value here was measured from the two sample reports in `docs/requirements/`, not
 * carried over from the placeholder that ARCHITECTURE.md §11.6 originally carried — that
 * placeholder had the wrong labels and put the third boundary at 50.
 *
 * This file is the only place in the codebase that hard-codes a colour.
 */

export type RatingBandToken =
  | 'band-outstanding'
  | 'band-on-track'
  | 'band-improving'
  | 'band-needs-support';

export interface RatingBand {
  token: RatingBandToken;
  /** Inclusive lower bound, as a percentage. The band runs up to the next band's bound. */
  minPercentage: number;
  label: string;
  /** Text and stroke colour. */
  color: string;
  /** Table-cell fill. */
  tint: string;
}

/** Ordered high to low, which is the order the report's rating-scale pills render in. */
export const RATING_BANDS: readonly RatingBand[] = [
  {
    token: 'band-outstanding',
    minPercentage: 90,
    label: 'Outstanding',
    color: '#1B7F4B',
    tint: '#E2F4E9',
  },
  {
    token: 'band-on-track',
    minPercentage: 75,
    label: 'On Track',
    color: '#2A7097',
    tint: '#E2EEF7',
  },
  {
    token: 'band-improving',
    minPercentage: 60,
    label: 'Improving',
    color: '#BE7D0F',
    tint: '#FDF3DB',
  },
  {
    token: 'band-needs-support',
    minPercentage: 0,
    label: 'Needs Support',
    color: '#B3261E',
    tint: '#FCE7E5',
  },
] as const;

/**
 * `percentage → band`. A fully-NA section scores `null` (D4) and is **not** a band — it
 * renders as `N/A` and is excluded from its parent, so this returns `null` rather than
 * falling through to "Needs Support".
 */
export function bandFor(percentage: number | null): RatingBand | null {
  if (percentage === null || Number.isNaN(percentage)) {
    return null;
  }
  for (const band of RATING_BANDS) {
    if (percentage >= band.minPercentage) {
      return band;
    }
  }
  // Unreachable: the last band's bound is 0 and percentages are non-negative.
  return RATING_BANDS[RATING_BANDS.length - 1] ?? null;
}

export interface ResponseToken {
  label: string;
  color: string;
  /** `null` for NA, which is not a number (ARCHITECTURE.md §5.1). */
  marks: number | null;
}

export const RESPONSE_TOKENS: Readonly<Record<string, ResponseToken>> = {
  SCORE_2: { label: 'Well implemented', color: '#1B7F4B', marks: 2 },
  SCORE_1: { label: 'Progressing well', color: '#BE7D0F', marks: 1 },
  SCORE_0: { label: 'Needs improvement', color: '#B3261E', marks: 0 },
  // The sample reports contain no NA row, so this grey is the one value here that is a
  // house choice rather than a measurement (DECISIONS.md R-6b).
  NA: { label: 'Not applicable', color: '#6B7280', marks: null },
} as const;

/**
 * Report palette from the approved Zone1Press reference: maroon masthead, orange mark
 * and warm paper rules. Rating meanings remain in RATING_BANDS / RESPONSE_TOKENS.
 * Copied into each snapshot so previously issued payloads retain their colours.
 */
export const BRAND_TOKENS = {
  ink: '#601A16',
  inkSoft: '#735650',
  hairline: '#EAD2CA',
  panel: '#FFF8F4',
  accent: '#FF7300',
} as const;
