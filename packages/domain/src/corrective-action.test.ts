import { describe, expect, it } from 'vitest';
import {
  awaitsResponse,
  awaitsReview,
  isOverdue,
  rollupAuditStatus,
  rollupPath,
  submissionTarget,
} from './corrective-action';
import { canTransition } from './state-machine';

describe('audit rollup (§2.8)', () => {
  it('closes an audit that raised nothing', () => {
    expect(rollupAuditStatus([])).toBe('CLOSED');
  });

  it('stays open while nothing is verified — a submission is not a resolution', () => {
    expect(rollupAuditStatus(['OPEN', 'ACTION_SUBMITTED', 'NOT_POSSIBLE', 'REOPENED'])).toBe(
      'CORRECTIVE_ACTION_OPEN',
    );
  });

  it('is partially closed while some are verified', () => {
    expect(rollupAuditStatus(['VERIFIED', 'OPEN'])).toBe('PARTIALLY_CLOSED');
  });

  it('closes once every action is verified', () => {
    expect(rollupAuditStatus(['VERIFIED', 'VERIFIED'])).toBe('CLOSED');
  });
});

describe('rollupPath', () => {
  it('is empty when the audit is already there', () => {
    expect(rollupPath('PARTIALLY_CLOSED', 'PARTIALLY_CLOSED')).toEqual([]);
  });

  it('refuses a status outside the rollup', () => {
    expect(rollupPath('IN_PROGRESS', 'CLOSED')).toBeNull();
  });

  it.each([
    ['COMPLETED', 'CORRECTIVE_ACTION_OPEN', ['CORRECTIVE_ACTION_OPEN']],
    ['COMPLETED', 'CLOSED', ['CLOSED']],
    ['CORRECTIVE_ACTION_OPEN', 'PARTIALLY_CLOSED', ['PARTIALLY_CLOSED']],
    ['PARTIALLY_CLOSED', 'CLOSED', ['CLOSED']],
    ['PARTIALLY_CLOSED', 'CORRECTIVE_ACTION_OPEN', ['CORRECTIVE_ACTION_OPEN']],
    ['CLOSED', 'PARTIALLY_CLOSED', ['PARTIALLY_CLOSED']],
    // No direct edge exists; a single reopened action on a closed audit walks two.
    ['CLOSED', 'CORRECTIVE_ACTION_OPEN', ['PARTIALLY_CLOSED', 'CORRECTIVE_ACTION_OPEN']],
  ] as const)('%s → %s walks %j', (from, to, steps) => {
    expect(rollupPath(from, to)?.map((edge) => edge.to)).toEqual(steps);
  });

  it('only ever returns edges the state machine accepts', () => {
    for (const edge of rollupPath('CLOSED', 'CORRECTIVE_ACTION_OPEN')!) {
      const role = edge.actors.length === 0 ? null : 'SUPER_ADMIN';
      expect(canTransition('audit', edge.from, edge.to, { role }).allowed).toBe(true);
    }
  });
});

describe('corrective-action helpers', () => {
  it('maps each option to its target (R-23)', () => {
    // An after-photo closes the item at once; "not possible" still waits for a Super Admin.
    expect(submissionTarget('COMPLETED')).toBe('VERIFIED');
    expect(submissionTarget('NOT_POSSIBLE')).toBe('NOT_POSSIBLE');
  });

  it('lets an answer with an after-photo close an open or reopened item directly (R-23)', () => {
    for (const from of ['OPEN', 'REOPENED'] as const) {
      expect(canTransition('corrective_action', from, 'VERIFIED', { role: 'ZONE_LEADER' })).toEqual({
        allowed: true,
      });
    }
    expect(awaitsReview(submissionTarget('COMPLETED'))).toBe(false);
  });

  it('splits the two to-do lists', () => {
    expect(awaitsResponse('OPEN')).toBe(true);
    expect(awaitsResponse('REOPENED')).toBe(true);
    expect(awaitsResponse('ACTION_SUBMITTED')).toBe(false);
    expect(awaitsReview('ACTION_SUBMITTED')).toBe(true);
    expect(awaitsReview('NOT_POSSIBLE')).toBe(true);
    expect(awaitsReview('VERIFIED')).toBe(false);
  });

  it('is overdue only while waiting on the Zone Leader', () => {
    const past = '2026-01-01T00:00:00.000Z';
    const now = Date.parse('2026-02-01T00:00:00.000Z');
    expect(isOverdue('OPEN', past, now)).toBe(true);
    expect(isOverdue('ACTION_SUBMITTED', past, now)).toBe(false);
    expect(isOverdue('OPEN', null, now)).toBe(false);
  });
});
