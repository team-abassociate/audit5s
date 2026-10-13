import { describe, expect, it } from 'vitest';
import type { NotificationPage } from '@audit5s/contracts';
import { activeCrossAuditCall } from './cross-audit-call';

const now = Date.parse('2026-10-13T10:00:00Z');
const call = (id: string, createdAt: string, unitId = 'u1') =>
  ({ id, eventType: 'CROSS_AUDIT_CALLED', unitId, createdAt, data: { unitName: 'Pune' } }) as unknown as NotificationPage['data'][number];

describe('activeCrossAuditCall', () => {
  it('shows the newest call under 7 days old', () => {
    const calls = [call('old', '2026-10-10T00:00:00Z'), call('new', '2026-10-12T00:00:00Z'), call('stale', '2026-10-05T00:00:00Z')];
    expect(activeCrossAuditCall(calls, [], now)?.id).toBe('new');
    expect(activeCrossAuditCall([calls[2]!], [], now)).toBeNull();
  });

  it('is answered by a cross audit at that Unit started after the call, and nothing else', () => {
    const calls = [call('c', '2026-10-12T00:00:00Z')];
    const audit = (auditType: string, unitId: string, startedAt: string | null) => ({ auditType, unitId, startedAt });
    expect(activeCrossAuditCall(calls, [audit('CROSS_5S', 'u1', '2026-10-12T09:00:00Z')], now)).toBeNull();
    expect(activeCrossAuditCall(calls, [audit('CROSS_5S', 'u1', '2026-10-11T09:00:00Z')], now)?.id).toBe('c');
    expect(activeCrossAuditCall(calls, [audit('CROSS_5S', 'u2', '2026-10-12T09:00:00Z')], now)?.id).toBe('c');
    expect(activeCrossAuditCall(calls, [audit('EXTERNAL_5S', 'u1', '2026-10-12T09:00:00Z')], now)?.id).toBe('c');
  });
});
