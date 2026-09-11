import { describe, expect, it } from 'vitest';
import type { ResponseValue, SSection } from '@audit5s/contracts';
import { S_SECTION_ORDER, QUESTIONS_PER_SECTION, TOTAL_QUESTIONS } from './sections';
import {
  numericScoreFor,
  percentageOf,
  rollUpBreakdowns,
  scoreResponses,
  scoreZone,
  sumSections,
  sumTotals,
  type ScorableResponse,
} from './scoring';

/**
 * The scoring truth table (PART 14, Phase 3 tests row).
 *
 * Every case the roadmap names — all-NA, single-NA, all-zero, mixed — plus the two the
 * business would notice first if they were wrong: that a fully-NA section is excluded from
 * its parent rather than dragging it to zero, and that a roll-up sums marks rather than
 * averaging percentages.
 */

function responses(section: SSection, values: readonly ResponseValue[]): ScorableResponse[] {
  return values.map((value) => ({ section, value }));
}

/** Ten of one value — one whole section. */
function section(sSection: SSection, value: ResponseValue): ScorableResponse[] {
  return responses(sSection, Array.from({ length: QUESTIONS_PER_SECTION }, () => value));
}

describe('the denominator rule (D3)', () => {
  it('scores a perfect section 100%', () => {
    const totals = scoreResponses(section('S1_SORT', 'SCORE_2'));
    expect(totals).toEqual({
      applicableQuestions: 10,
      naQuestions: 0,
      rawScore: 20,
      maxScore: 20,
      scorePercentage: 100,
    });
  });

  it('scores an all-zero section 0%, which is a number and not null', () => {
    const totals = scoreResponses(section('S1_SORT', 'SCORE_0'));
    expect(totals.rawScore).toBe(0);
    expect(totals.maxScore).toBe(20);
    // The distinction that matters: answered-and-failed is 0%, unanswerable is null.
    expect(totals.scorePercentage).toBe(0);
  });

  it('excludes a single NA from the denominator rather than scoring it zero', () => {
    const totals = scoreResponses([
      ...responses('S1_SORT', ['SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2']),
      ...responses('S1_SORT', ['SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2']),
      ...responses('S1_SORT', ['NA']),
    ]);

    expect(totals.applicableQuestions).toBe(9);
    expect(totals.naQuestions).toBe(1);
    expect(totals.maxScore).toBe(18);
    // Scoring NA as a failure would have produced 90% here. It is 100%.
    expect(totals.scorePercentage).toBe(100);
  });

  it('mixes 2 / 1 / 0 / NA the way the sample report does', () => {
    const totals = scoreResponses(
      responses('S2_SET_IN_ORDER', [
        'SCORE_2',
        'SCORE_2',
        'SCORE_1',
        'SCORE_1',
        'SCORE_0',
        'NA',
        'SCORE_2',
        'SCORE_1',
        'SCORE_0',
        'SCORE_2',
      ]),
    );

    expect(totals.applicableQuestions).toBe(9);
    expect(totals.naQuestions).toBe(1);
    expect(totals.rawScore).toBe(11);
    expect(totals.maxScore).toBe(18);
    expect(totals.scorePercentage).toBe(61.111);
  });
});

describe('a fully-NA section is null, not zero (D4)', () => {
  it('returns null for the section', () => {
    const totals = scoreResponses(section('S3_SHINE', 'NA'));
    expect(totals.applicableQuestions).toBe(0);
    expect(totals.naQuestions).toBe(10);
    expect(totals.maxScore).toBe(0);
    expect(totals.scorePercentage).toBeNull();
  });

  it('excludes it from the Zone rather than dragging the Zone down', () => {
    const zone = scoreZone([
      ...section('S1_SORT', 'SCORE_2'),
      ...section('S2_SET_IN_ORDER', 'SCORE_2'),
      ...section('S3_SHINE', 'NA'),
      ...section('S4_STANDARDIZE', 'SCORE_2'),
      ...section('S5_SUSTAIN', 'SCORE_2'),
    ]);

    expect(zone.sections.find((s) => s.section === 'S3_SHINE')?.scorePercentage).toBeNull();
    expect(zone.totals.applicableQuestions).toBe(40);
    expect(zone.totals.naQuestions).toBe(10);
    expect(zone.totals.maxScore).toBe(80);
    // Averaging the five section percentages would have given 80%. Summing gives 100%.
    expect(zone.totals.scorePercentage).toBe(100);
  });

  it('returns null for a Zone in which every one of the fifty questions is NA', () => {
    const zone = scoreZone(S_SECTION_ORDER.flatMap((s) => section(s, 'NA')));
    expect(zone.totals.naQuestions).toBe(TOTAL_QUESTIONS);
    expect(zone.totals.scorePercentage).toBeNull();
    expect(zone.sections.every((s) => s.scorePercentage === null)).toBe(true);
  });
});

describe('scoreZone', () => {
  it('always returns all five sections in workbook order, even with no responses', () => {
    const zone = scoreZone([]);
    expect(zone.sections.map((s) => s.section)).toEqual([...S_SECTION_ORDER]);
    expect(zone.totals.scorePercentage).toBeNull();
  });

  it('produces the §8.6 worked example', () => {
    // 47 applicable, 3 NA, 79 raw of 94 max → 84.043 %.
    const zone = scoreZone([
      ...responses('S1_SORT', [
        'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2',
        'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_1', 'SCORE_0',
      ]),
      ...responses('S2_SET_IN_ORDER', [
        'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2',
        'SCORE_2', 'SCORE_2', 'SCORE_1', 'SCORE_0', 'NA',
      ]),
      ...responses('S3_SHINE', [
        'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2',
        'SCORE_2', 'SCORE_1', 'SCORE_1', 'SCORE_0', 'NA',
      ]),
      ...responses('S4_STANDARDIZE', [
        'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2',
        'SCORE_2', 'SCORE_1', 'SCORE_1', 'SCORE_0', 'NA',
      ]),
      ...responses('S5_SUSTAIN', [
        'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2',
        'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_2', 'SCORE_1',
      ]),
    ]);

    expect(zone.totals.applicableQuestions).toBe(47);
    expect(zone.totals.naQuestions).toBe(3);
    expect(zone.totals.rawScore).toBe(79);
    expect(zone.totals.maxScore).toBe(94);
    expect(zone.totals.scorePercentage).toBe(84.043);

    // The two section rows the document prints alongside those totals.
    expect(zone.sections.find((s) => s.section === 'S1_SORT')?.scorePercentage).toBe(85);
    expect(zone.sections.find((s) => s.section === 'S2_SET_IN_ORDER')?.scorePercentage).toBe(83.333);
  });
});

describe('roll-ups sum marks, never average percentages (§10.3-C)', () => {
  it('rolls Zones into an audit by summing', () => {
    // One perfect ten-question Zone and one all-zero fifty-question Zone. The mean of the
    // percentages is 50%; the correct answer is 20/120 = 16.667%.
    const small = scoreZone(section('S1_SORT', 'SCORE_2'));
    const large = scoreZone(S_SECTION_ORDER.flatMap((s) => section(s, 'SCORE_0')));

    const audit = rollUpBreakdowns([small, large]);
    expect(audit.totals.rawScore).toBe(20);
    expect(audit.totals.maxScore).toBe(120);
    expect(audit.totals.scorePercentage).toBe(16.667);
  });

  it('sums per S across Zones', () => {
    const a = scoreZone(section('S1_SORT', 'SCORE_2'));
    const b = scoreZone([...section('S1_SORT', 'SCORE_0'), ...section('S2_SET_IN_ORDER', 'NA')]);

    const sections = sumSections([a, b]);
    const s1 = sections.find((s) => s.section === 'S1_SORT');
    expect(s1?.rawScore).toBe(20);
    expect(s1?.maxScore).toBe(40);
    expect(s1?.scorePercentage).toBe(50);

    // Nothing applicable in S2 across either Zone: still null, still not zero.
    expect(sections.find((s) => s.section === 'S2_SET_IN_ORDER')?.scorePercentage).toBeNull();
  });

  it('sums an empty list to nothing applicable', () => {
    expect(sumTotals([]).scorePercentage).toBeNull();
    expect(rollUpBreakdowns([]).totals.applicableQuestions).toBe(0);
  });
});

describe('percentage arithmetic', () => {
  it('is null on a zero denominator and never NaN', () => {
    expect(percentageOf(0, 0)).toBeNull();
    expect(percentageOf(5, -1)).toBeNull();
  });

  it('rounds to three decimals, matching the numeric(6,3) column', () => {
    expect(percentageOf(1, 3)).toBe(33.333);
    expect(percentageOf(2, 3)).toBe(66.667);
    expect(percentageOf(79, 94)).toBe(84.043);
  });
});

describe('numericScoreFor is the writer half of QR-1', () => {
  it('is null for NA and the mark otherwise', () => {
    expect(numericScoreFor('NA')).toBeNull();
    expect(numericScoreFor('SCORE_0')).toBe(0);
    expect(numericScoreFor('SCORE_1')).toBe(1);
    expect(numericScoreFor('SCORE_2')).toBe(2);
  });
});
