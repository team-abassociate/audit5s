import { describe, expect, it } from 'vitest';
import type { CrossAuditCall } from '@audit5s/contracts';
import { isOverdue, openCrossAuditCalls } from './cross-audit-call';

const call = (id: string, createdAt: string, zoneId: string, unitId = 'u1') =>
  ({ id, unitId, zoneId, createdAt, dueOn: '2026-10-18' }) as CrossAuditCall;
const audit = (auditType: string, unitId: string, startedAt: string | null, zoneIds: string | null = null) => ({
  auditType,
  unitId,
  startedAt,
  zoneIds,
});
const ids = (calls: { id: string }[]) => calls.map((c) => c.id);

describe('openCrossAuditCalls', () => {
  it('hides a call this phone answered: a cross audit of its Zone, at its Unit, started after it', () => {
    const calls = [call('a', '2026-10-12T00:00:00Z', 'z1'), call('b', '2026-10-12T01:00:00Z', 'z2')];
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u1', '2026-10-12T09:00:00Z', 'z1')]))).toEqual(['b']);
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u1', '2026-10-12T09:00:00Z', 'z9,z2')]))).toEqual(['a']);
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u1', '2026-10-11T09:00:00Z', 'z1')]))).toEqual(['a', 'b']);
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u2', '2026-10-12T09:00:00Z', 'z1')]))).toEqual(['a', 'b']);
    expect(ids(openCrossAuditCalls(calls, [audit('EXTERNAL_5S', 'u1', '2026-10-12T09:00:00Z', 'z1')]))).toEqual(['a', 'b']);
    // A selfie with no Zone yet answers nothing.
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u1', '2026-10-12T09:00:00Z', null)]))).toEqual(['a', 'b']);
  });
});

describe('isOverdue', () => {
  it('is overdue from the day after it was due, in IST', () => {
    const due = { dueOn: '2026-10-18' };
    expect(isOverdue(due, new Date('2026-10-18T18:00:00Z'))).toBe(false); // 23:30 IST on the 18th
    expect(isOverdue(due, new Date('2026-10-18T18:31:00Z'))).toBe(true); // 00:01 IST on the 19th
  });
});
