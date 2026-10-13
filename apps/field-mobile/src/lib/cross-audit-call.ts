import type { NotificationPage } from '@audit5s/contracts';

const CROSS_AUDIT_CALL_DAYS = 7;

/**
 * The newest cross-audit call still standing: under 7 days old, and no cross audit started
 * at that Unit since (owner, 2026-10-13).
 *
 * ponytail: only audits on this device count as answering a call; a server-side "answered"
 * flag on the call is the upgrade if a Zone Leader ever answers from a second phone.
 */
export function activeCrossAuditCall(
  notifications: NotificationPage['data'],
  audits: { auditType: string; unitId: string; startedAt: string | null }[],
  now = Date.now(),
) {
  return (
    notifications
      .filter((notification) => {
        if (notification.eventType !== 'CROSS_AUDIT_CALLED') return false;
        const calledAt = Date.parse(notification.createdAt);
        if (now - calledAt > CROSS_AUDIT_CALL_DAYS * 86_400_000) return false;
        return !audits.some(
          (audit) =>
            audit.auditType === 'CROSS_5S' &&
            audit.unitId === notification.unitId &&
            audit.startedAt !== null &&
            Date.parse(audit.startedAt) > calledAt,
        );
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
  );
}
