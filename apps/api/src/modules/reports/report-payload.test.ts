import { describe, expect, it } from 'vitest';
import { freezePayload, freezeTrendPayload, unitTrend, type FreezeInput } from './report-payload';

/**
 * Field report, 2026-09-30: an after-evidence report printed each finding's own photograph
 * in its AFTER PHOTO slot. The Zone Leader's photograph was stored and cited correctly; the
 * freeze copied the before-photo's fields over it, so the PDF drew one image twice.
 */

const BEFORE_KEY = 'evidence/unit-1/audit-1/zone-1/before.jpg';
const AFTER_KEY = 'corrective/unit-1/action-1/attempt-1/after.jpg';

function input(): FreezeInput {
  const at = new Date('2026-09-23T06:00:00Z');
  return {
    kind: 'AFTER_EVIDENCE_ZONE',
    snapshotId: 'snapshot-1',
    version: 2,
    generatedAt: new Date('2026-09-30T10:00:00Z'),
    generatedByName: 'Sam Admin',
    unit: { id: 'unit-1', name: 'Unit A', address: null, city: null, state: null },
    zones: [
      {
        auditZoneId: 'zone-1',
        auditId: 'audit-1',
        auditType: 'EXTERNAL_5S',
        zoneCode: '16',
        zoneName: 'Trimming',
        zoneDescription: null,
        zoneLeaderName: 'A Leader',
        auditeeName: 'S. Patil',
        departmentName: 'Production',
        checklistVersionNo: 1,
        auditCompletedAt: at,
        completedAt: at,
        auditStartedAt: at,
        auditorName: 'An Auditor',
        auditorLoginId: 'AA0001',
        applicableQuestions: 1,
        naQuestions: 0,
        rawScore: 0,
        maxScore: 2,
        scorePercentage: '0',
        zoneRemark: null,
      },
    ],
    sectionScores: [],
    responses: [],
    photos: [
      {
        id: 'before-1',
        auditZoneId: 'zone-1',
        objectKey: BEFORE_KEY,
        redactedAt: null,
        classification: 'NONCONFORMITY',
        remark: 'Scrap on the floor',
        capturedAt: at,
        isSummaryFlagged: false,
        scoreAtCapture: 'SCORE_0',
        questionGlobalOrder: 1,
        questionText: 'Only required material at the line',
        section: 'S1_SORT',
      },
    ],
    actions: [
      {
        id: 'action-1',
        evidenceId: 'before-1',
        auditZoneId: 'zone-1',
        suggestion: null,
        suggestionNo: null,
        status: 'VERIFIED',
        dueAt: null,
        openedAt: at,
        resolvedAt: new Date('2026-09-30T09:00:00Z'),
        assignedZoneLeaderUserId: null,
        unitId: 'unit-1',
        submissionOption: 'COMPLETED',
        submittedByName: 'A Leader',
        submittedAt: new Date('2026-09-30T08:00:00Z'),
        description: 'Cleared',
        explanation: null,
        afterEvidenceId: 'after-1',
        afterObjectKey: AFTER_KEY,
        afterRedactedAt: null,
        afterCapturedAt: new Date('2026-09-30T07:55:00Z'),
        reviewOutcome: null,
        reviewedAt: null,
        reviewComment: null,
        reviewer: null,
      },
    ],
    selfieObjectKey: null,
    auditeePhotoKeys: new Map([['zone-1', 'auditee-key']]),
    history: [],
    actionUrls: new Map(),
  } as unknown as FreezeInput;
}

describe('freezePayload', () => {
  it('carries the auditee and their photo onto the Zone (R-72)', () => {
    const [zone] = freezePayload(input()).zones;
    expect(zone).toMatchObject({ auditeeName: 'S. Patil', auditeePhotoObjectKey: 'auditee-key' });
  });

  it('prints a Zone report’s history oldest first, and none on a summary', () => {
    const history = [
      { auditZoneId: 'zone-1', auditDate: new Date('2026-09-23T06:00:00Z'), rawScore: 70, maxScore: 80, scorePercentage: '87.500' },
      { auditZoneId: 'zone-0', auditDate: new Date('2026-08-20T06:00:00Z'), rawScore: 50, maxScore: 80, scorePercentage: '62.500' },
    ];
    const [zone] = freezePayload({ ...input(), history }).zones;
    expect(zone!.history).toEqual([
      { auditZoneId: 'zone-0', auditDate: '2026-08-20T06:00:00.000Z', rawScore: 50, maxScore: 80, scorePercentage: 62.5 },
      { auditZoneId: 'zone-1', auditDate: '2026-09-23T06:00:00.000Z', rawScore: 70, maxScore: 80, scorePercentage: 87.5 },
    ]);

    const [summarised] = freezePayload({ ...input(), kind: 'MULTI_ZONE_SUMMARY', history }).zones;
    expect(summarised!.history).toBeUndefined();
  });

  it('keeps a finding’s after photo its own, not the before photo', () => {
    const [finding] = freezePayload(input()).zones[0]!.nonconformities;

    expect(finding!.objectKey).toBe(BEFORE_KEY);
    expect(finding!.outcome!.afterPhoto).toMatchObject({
      evidenceId: 'after-1',
      objectKey: AFTER_KEY,
      capturedAt: '2026-09-30T07:55:00.000Z',
      remark: null,
      // The question it answers is the finding's, which is what the caption prints.
      questionGlobalOrder: 1,
      section: 'S1_SORT',
    });
  });

  it('prints a deleted response as unanswered until the Zone Leader answers again (R-40)', () => {
    const reopened = input();
    // Deleting a response is the reopen edge; the attempt is still the latest one.
    reopened.actions[0]!.status = 'REOPENED';
    reopened.actions[0]!.resolvedAt = null;

    const [finding] = freezePayload(reopened).zones[0]!.nonconformities;

    expect(finding!.status).toBe('REOPENED');
    expect(finding!.outcome).toBeNull();
    // The finding's own photograph is unaffected.
    expect(finding!.objectKey).toBe(BEFORE_KEY);
  });

  /** R-43: who reviewed the latest answer, carried beside it — or in its place. */
  describe('the review', () => {
    const reviewed = (
      status: 'VERIFIED' | 'REOPENED',
      outcome: 'VERIFIED' | 'REOPENED' | null,
    ): FreezeInput => {
      const frozen = input();
      const action = frozen.actions[0]! as FreezeInput['actions'][number];
      action.status = status;
      if (status === 'REOPENED') action.resolvedAt = null;
      action.reviewOutcome = outcome;
      action.reviewedAt = outcome ? new Date('2026-10-01T05:30:00Z') : null;
      action.reviewComment = outcome === 'REOPENED' ? 'Scrap is back under the bench' : null;
      action.reviewer = outcome ? { name: 'Cole Coord', role: 'COORDINATOR' } : null;
      return frozen;
    };

    it('says nothing of a closure nobody reviewed, and still prints it', () => {
      const [finding] = freezePayload(reviewed('VERIFIED', null)).zones[0]!.nonconformities;
      expect(finding!.review).toBeNull();
      expect(finding!.outcome?.afterPhoto?.objectKey).toBe(AFTER_KEY);
    });

    it('names the approver and their role beside the answer', () => {
      const [finding] = freezePayload(reviewed('VERIFIED', 'VERIFIED')).zones[0]!.nonconformities;
      expect(finding!.outcome).not.toBeNull();
      expect(finding!.review).toEqual({
        verdict: 'APPROVED',
        reviewerName: 'Cole Coord',
        reviewerRole: 'COORDINATOR',
        reviewedAt: '2026-10-01T05:30:00.000Z',
        comment: null,
      });
    });

    it('drops a disapproved answer and keeps who disapproved it, and why', () => {
      const [finding] = freezePayload(reviewed('REOPENED', 'REOPENED')).zones[0]!.nonconformities;
      expect(finding!.outcome).toBeNull();
      expect(finding!.review).toMatchObject({
        verdict: 'DISAPPROVED',
        reviewerName: 'Cole Coord',
        comment: 'Scrap is back under the bench',
      });
    });
  });
});

describe('freezeTrendPayload (R-75)', () => {
  const section = (raw: number, max: number) =>
    (['S1_SORT', 'S2_SET_IN_ORDER', 'S3_SHINE', 'S4_STANDARDIZE', 'S5_SUSTAIN'] as const).map((s, i) => ({
      section: s,
      applicable: i === 0 ? 10 : 0,
      na: 0,
      raw: i === 0 ? raw : 0,
      max: i === 0 ? max : 0,
      pct: i === 0 ? (raw / max) * 100 : null,
    }));
  const summary = (id: string, from: string, raw: number, max: number) => ({
    id,
    from,
    to: from,
    zoneCount: 3,
    totals: { applicableQuestions: 10, naQuestions: 0, rawScore: raw, maxScore: max, scorePercentage: (raw / max) * 100 },
    sections: section(raw, max),
    auditorNames: ['B. Auditor', 'A. Auditor'],
  });

  it('orders points oldest first and sums marks rather than averaging percentages', () => {
    const payload = freezeTrendPayload({
      snapshotId: 'snapshot-1',
      version: 1,
      generatedAt: new Date('2026-10-31T10:00:00Z'),
      generatedByName: 'Sam Admin',
      unit: { id: 'unit-1', name: 'Unit A', address: null, city: null, state: null },
      // A big summary at 90% and a small one at 10%: the mean would be 50%.
      trend: unitTrend([summary('late', '2026-09-01T00:00:00.000Z', 9, 10), summary('early', '2026-08-01T00:00:00.000Z', 90, 100)]),
      auditorNames: ['B. Auditor', 'A. Auditor', 'A. Auditor'],
    });

    expect(payload.kind).toBe('TREND_SUMMARY');
    expect(payload.trend!.points.map((point) => point.id)).toEqual(['early', 'late']);
    expect(payload.totals).toMatchObject({ rawScore: 99, maxScore: 110 });
    expect(payload.totals.scorePercentage).toBeCloseTo(90, 3);
    expect(payload.auditDateRange).toEqual({ from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' });
    expect(payload.auditorNames).toEqual(['A. Auditor', 'B. Auditor']);
    expect(payload.zones).toEqual([]);
  });
});
