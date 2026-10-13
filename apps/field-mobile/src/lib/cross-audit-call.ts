import type { CrossAuditCall } from '@audit5s/contracts';
import { istDateKey } from '@audit5s/domain';

/**
 * The Unit's calls still standing, as the server reads them (0050, owner 2026-10-14): a call
 * leaves once anyone starts an audit of its Zone, and not before — past its date it stays,
 * overdue. Less any this phone has answered with an audit the server has not heard of yet:
 * a cross audit at that Unit, started after the call, with that Zone in it.
 */
export function openCrossAuditCalls(
  calls: CrossAuditCall[],
  audits: { auditType: string; unitId: string; startedAt: string | null; zoneIds: string | null }[],
): CrossAuditCall[] {
  return calls.filter(
    (call) =>
      !audits.some(
        (audit) =>
          audit.auditType === 'CROSS_5S' &&
          audit.unitId === call.unitId &&
          audit.startedAt !== null &&
          Date.parse(audit.startedAt) > Date.parse(call.createdAt) &&
          (audit.zoneIds ?? '').split(',').includes(call.zoneId),
      ),
  );
}

/** Past the day it was due, in the plant's day (IST). Due today is not overdue. */
export function isOverdue(call: Pick<CrossAuditCall, 'dueOn'>, now: Date = new Date()): boolean {
  return call.dueOn < (istDateKey(now) ?? call.dueOn);
}
