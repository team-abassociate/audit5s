import { describe, expect, it } from 'vitest';
import {
  correctiveActionSummaryQuerySchema,
  correctiveActionSummarySchema,
  listCorrectiveActionsQuerySchema,
} from './corrective-action';
import { syncConflictSummaryQuerySchema } from './sync';

describe('listCorrectiveActionsQuerySchema (CA10)', () => {
  it('keeps the old query unchanged: no order, no group, the field app’s id order', () => {
    expect(listCorrectiveActionsQuerySchema.parse({ limit: '200', overdue: 'true' })).toEqual({
      limit: 200,
      overdue: true,
      awaitingReview: false,
    });
  });

  it('reads a sort, a group and the review filter, and refuses anything else', () => {
    expect(
      listCorrectiveActionsQuerySchema.parse({ sort: 'leader', group: 'audit', awaitingReview: 'true' }),
    ).toMatchObject({ sort: 'leader', group: 'audit', awaitingReview: true });
    expect(listCorrectiveActionsQuerySchema.safeParse({ sort: 'zone' }).success).toBe(false);
    expect(listCorrectiveActionsQuerySchema.safeParse({ group: 'owner' }).success).toBe(false);
  });

  it('summary takes the filters and drops paging and order', () => {
    const parsed = correctiveActionSummaryQuerySchema.parse({
      unitId: '00000000-0000-4000-8000-000000000001',
      overdue: 'true',
      cursor: 'x',
      sort: 'due',
    });
    expect(parsed).toEqual({
      unitId: '00000000-0000-4000-8000-000000000001',
      overdue: true,
      awaitingReview: false,
    });
    expect(syncConflictSummaryQuerySchema.parse({ resolved: 'false', limit: '5' })).toEqual({ resolved: false });
  });

  it('a summary must count every status', () => {
    const base = {
      total: 1,
      overdue: 0,
      dueWithinWeek: 0,
      openNeedsImprovement: 0,
      byAudit: [],
      byZoneLeader: [],
    };
    const byStatus = { OPEN: 1, ACTION_SUBMITTED: 0, NOT_POSSIBLE: 0, VERIFIED: 0, REOPENED: 0, WITHDRAWN: 0 };
    expect(correctiveActionSummarySchema.safeParse({ ...base, byStatus }).success).toBe(true);
    expect(correctiveActionSummarySchema.safeParse({ ...base, byStatus: { OPEN: 1 } }).success).toBe(false);
  });
});
