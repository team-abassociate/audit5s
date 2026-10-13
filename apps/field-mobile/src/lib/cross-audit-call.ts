import type { NotificationPage } from '@audit5s/contracts';

const CROSS_AUDIT_CALL_DAYS = 7;

type CrossAuditCall = NotificationPage['data'][number];

/** The Zone a call names; null for a call made before calls named one, which means any Zone. */
export function crossAuditCallZoneId(call: CrossAuditCall): string | null {
  return typeof call.data.zoneId === 'string' ? call.data.zoneId : null;
}

/**
 * Every cross-audit call still standing, newest first (owner, 2026-10-13): under 7 days old,
 * and not yet answered by a cross audit at that Unit, started after the call, that includes
 * the Zone it names. An older call without a Zone is answered by any cross audit at the Unit
 * with a Zone started.
 *
 * ponytail: only audits on this device count as answering a call; a server-side "answered"
 * flag on the call is the upgrade if a Zone Leader ever answers from a second phone.
 */
export function openCrossAuditCalls(
  notifications: NotificationPage['data'],
  audits: { auditType: string; unitId: string; startedAt: string | null; zoneIds: string | null }[],
  now = Date.now(),
): CrossAuditCall[] {
  return notifications
    .filter((notification) => {
      if (notification.eventType !== 'CROSS_AUDIT_CALLED') return false;
      const calledAt = Date.parse(notification.createdAt);
      if (now - calledAt > CROSS_AUDIT_CALL_DAYS * 86_400_000) return false;
      const zoneId = crossAuditCallZoneId(notification);
      return !audits.some((audit) => {
        // A selfie with no Zone yet answers nothing, or "Any Zone" calls vanish and come back.
        const zoneIds = audit.zoneIds ? audit.zoneIds.split(',') : [];
        return (
          audit.auditType === 'CROSS_5S' &&
          audit.unitId === notification.unitId &&
          audit.startedAt !== null &&
          Date.parse(audit.startedAt) > calledAt &&
          zoneIds.length > 0 &&
          (zoneId === null || zoneIds.includes(zoneId))
        );
      });
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
