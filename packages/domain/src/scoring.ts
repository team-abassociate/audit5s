import type { ResponseValue, SSection } from '@audit5s/contracts';
import { MAX_MARKS_PER_QUESTION, S_SECTION_ORDER, responseMarks } from './sections';

/**
 * Scoring (D3/D4/D5), pure and shared.
 *
 * There is exactly one implementation, and both the API and the device import it. That is
 * the point of putting it here rather than "the same formula" in two places: the acceptance
 * row for Phase 3 is that a Consultant's on-device number matches the server's *exactly*,
 * and the only way to guarantee that is for there to be one number, computed once, in code
 * both sides run.
 *
 * The three rules the rest of the file exists to enforce:
 *
 *   - **D3.** `NA` is excluded from the denominator, never scored as a zero. The maximum is
 *     `applicable × 2`, not `answered × 2`.
 *   - **D4.** A section in which every question is `NA` scores `null`, not `0`. 0/0 is
 *     undefined, and recording it as 0 % would silently destroy the Unit trend. `null` is
 *     rendered `N/A` and is excluded from its parent.
 *   - **D5.** The server recomputes. The device's number is display-only, so this module
 *     takes responses and returns totals — it never reads a stored score.
 */

/** One answered question, as scoring sees it. Nothing else about a response matters here. */
export interface ScorableResponse {
  section: SSection;
  value: ResponseValue;
}

/** The totals of any level: a section, a Zone, an audit, or a set of Zones in a summary. */
export interface ScoreTotals {
  /** Questions that count toward the denominator — everything but `NA`. */
  applicableQuestions: number;
  naQuestions: number;
  /** Marks achieved: 2, 1 or 0 per applicable question. */
  rawScore: number;
  /** `applicableQuestions × 2` (D3). */
  maxScore: number;
  /** `null` when nothing is applicable (D4) — never `0`. */
  scorePercentage: number | null;
}

export interface SectionScore extends ScoreTotals {
  section: SSection;
}

export interface ScoreBreakdown {
  totals: ScoreTotals;
  /** Always all five, in workbook order, so a renderer never has to fill gaps. */
  sections: SectionScore[];
}

/**
 * Percentages carry three decimals.
 *
 * `numeric(6,3)` is the column type in §5.5, so rounding here means the value the device
 * shows, the value the API returns and the value PostgreSQL stores are the same number
 * rather than three roundings of one. Reports print one decimal (A6) — that is a display
 * concern, applied at render time, not a second rounding of the stored value.
 */
export const SCORE_DECIMALS = 3;

export function roundPercentage(value: number): number {
  const factor = 10 ** SCORE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** `null` when the denominator is zero — the D4 rule, in one place. */
export function percentageOf(rawScore: number, maxScore: number): number | null {
  if (maxScore <= 0) {
    return null;
  }
  return roundPercentage((rawScore / maxScore) * 100);
}

const EMPTY: ScoreTotals = {
  applicableQuestions: 0,
  naQuestions: 0,
  rawScore: 0,
  maxScore: 0,
  scorePercentage: null,
};

/** Totals over a flat list of responses, ignoring which section each belongs to. */
export function scoreResponses(responses: readonly ScorableResponse[]): ScoreTotals {
  let applicableQuestions = 0;
  let naQuestions = 0;
  let rawScore = 0;

  for (const response of responses) {
    const marks = responseMarks(response.value);
    if (marks === null) {
      naQuestions += 1;
      continue;
    }
    applicableQuestions += 1;
    rawScore += marks;
  }

  const maxScore = applicableQuestions * MAX_MARKS_PER_QUESTION;
  return {
    applicableQuestions,
    naQuestions,
    rawScore,
    maxScore,
    scorePercentage: percentageOf(rawScore, maxScore),
  };
}

/**
 * A Zone's score: five section rows plus the Zone totals.
 *
 * The Zone total is `Σraw / Σmax` over the responses, **not** the mean of the five section
 * percentages. Those differ whenever sections have different applicable counts, and the
 * sample reports use the former (§4.3 states the same rule for the summary). Computing it
 * from the sums also means a fully-NA section drops out of the parent automatically,
 * which is exactly what D4 asks for — it contributes 0 to both sums.
 */
export function scoreZone(responses: readonly ScorableResponse[]): ScoreBreakdown {
  const bySection = new Map<SSection, ScorableResponse[]>();
  for (const section of S_SECTION_ORDER) {
    bySection.set(section, []);
  }
  for (const response of responses) {
    bySection.get(response.section)?.push(response);
  }

  const sections = S_SECTION_ORDER.map((section) => ({
    section,
    ...scoreResponses(bySection.get(section) ?? []),
  }));

  return { totals: sumTotals(sections), sections };
}

/**
 * Rolls several already-computed levels into one — Zones into an audit, or the selected
 * Zones of a summary report.
 *
 * Sums, never an average of percentages (§10.3-C). A 50-question Zone and a 10-question one
 * are not equal contributors, and averaging their percentages would make them so.
 */
export function sumTotals(parts: readonly ScoreTotals[]): ScoreTotals {
  const totals = parts.reduce<ScoreTotals>(
    (accumulator, part) => ({
      applicableQuestions: accumulator.applicableQuestions + part.applicableQuestions,
      naQuestions: accumulator.naQuestions + part.naQuestions,
      rawScore: accumulator.rawScore + part.rawScore,
      maxScore: accumulator.maxScore + part.maxScore,
      scorePercentage: null,
    }),
    { ...EMPTY },
  );

  return { ...totals, scorePercentage: percentageOf(totals.rawScore, totals.maxScore) };
}

/** The same roll-up, per S, across several Zones. The summary report's S-wise table. */
export function sumSections(breakdowns: readonly ScoreBreakdown[]): SectionScore[] {
  return S_SECTION_ORDER.map((section) => ({
    section,
    ...sumTotals(
      breakdowns.map(
        (breakdown) =>
          breakdown.sections.find((candidate) => candidate.section === section) ?? { ...EMPTY },
      ),
    ),
  }));
}

/** Zone breakdowns → the audit's own breakdown. */
export function rollUpBreakdowns(breakdowns: readonly ScoreBreakdown[]): ScoreBreakdown {
  return {
    totals: sumTotals(breakdowns.map((breakdown) => breakdown.totals)),
    sections: sumSections(breakdowns),
  };
}

/**
 * The numeric column of `question_response`, from the enum.
 *
 * Invariant QR-1 is a `CHECK` constraint: `numeric_score` is `NULL` iff `value = 'NA'`, so
 * `COUNT(numeric_score)` *is* the applicable-question count and the SQL roll-up needs no
 * special case. This is the writer's half of that constraint.
 */
export function numericScoreFor(value: ResponseValue): number | null {
  return responseMarks(value);
}
