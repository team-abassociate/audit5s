import { describe, expect, it } from 'vitest';
import type { NotificationPage } from '@audit5s/contracts';
import { openCrossAuditCalls } from './cross-audit-call';

const now = Date.parse('2026-10-13T10:00:00Z');
const call = (id: string, createdAt: string, zoneId?: string, unitId = 'u1') =>
  ({ id, eventType: 'CROSS_AUDIT_CALLED', unitId, createdAt, data: { unitName: 'Pune', ...(zoneId ? { zoneId } : {}) } }) as unknown as NotificationPage['data'][number];
const audit = (auditType: string, unitId: string, startedAt: string | null, zoneIds: string | null = null) => ({
  auditType,
  unitId,
  startedAt,
  zoneIds,
});
const ids = (calls: { id: string }[]) => calls.map((c) => c.id);

describe('openCrossAuditCalls', () => {
  it('lists every call under 7 days old, newest first', () => {
    const calls = [call('old', '2026-10-10T00:00:00Z', 'z1'), call('new', '2026-10-12T00:00:00Z', 'z2'), call('stale', '2026-10-05T00:00:00Z', 'z3')];
    expect(ids(openCrossAuditCalls(calls, [], now))).toEqual(['new', 'old']);
  });

  it('answers a call only by a cross audit of its Zone, at its Unit, started after it', () => {
    const calls = [call('a', '2026-10-12T00:00:00Z', 'z1'), call('b', '2026-10-12T01:00:00Z', 'z2')];
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u1', '2026-10-12T09:00:00Z', 'z1')], now))).toEqual(['b']);
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u1', '2026-10-12T09:00:00Z', 'z9,z2')], now))).toEqual(['a']);
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u1', '2026-10-11T09:00:00Z', 'z1')], now))).toEqual(['b', 'a']);
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u2', '2026-10-12T09:00:00Z', 'z1')], now))).toEqual(['b', 'a']);
    expect(ids(openCrossAuditCalls(calls, [audit('EXTERNAL_5S', 'u1', '2026-10-12T09:00:00Z', 'z1')], now))).toEqual(['b', 'a']);
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u1', '2026-10-12T09:00:00Z', null)], now))).toEqual(['b', 'a']);
  });

  it('answers an older call without a Zone by any cross audit at the Unit with a Zone started', () => {
    const calls = [call('any', '2026-10-12T00:00:00Z')];
    expect(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u1', '2026-10-12T09:00:00Z', 'z1')], now)).toEqual([]);
    // A selfie with no Zone yet: the call stays, so discarding it brings nothing back.
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u1', '2026-10-12T09:00:00Z', null)], now))).toEqual(['any']);
    expect(ids(openCrossAuditCalls(calls, [audit('CROSS_5S', 'u1', '2026-10-11T09:00:00Z', 'z1')], now))).toEqual(['any']);
  });
});
