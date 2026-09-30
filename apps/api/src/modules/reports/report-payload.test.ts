import { describe, expect, it } from 'vitest';
import { freezePayload, type FreezeInput } from './report-payload';

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
      },
    ],
    selfieObjectKey: null,
    actionUrls: new Map(),
  } as unknown as FreezeInput;
}

describe('freezePayload', () => {
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
});
