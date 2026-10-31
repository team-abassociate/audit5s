import { useQuery } from '@tanstack/react-query';
import type { Href } from 'expo-router';
import type { CrossAuditCall } from '@audit5s/contracts';
import { formatDayMonth, zoneDisplayLabel } from '@audit5s/domain';
import { api } from '../lib/api';
import { isOverdue, openCrossAuditCalls } from '../lib/cross-audit-call';
import { listLocalAudits } from '../lib/db/audit.repository';
import { useLocalDatabase } from '../lib/db/provider';
import { useSession } from '../lib/session';

/**
 * A Zone Leader's open cross-audit calls, oldest due first: the Overview's blue row and the
 * list behind it. Online only, and quiet when it fails: offline the calls just don't show.
 */
export function useOpenCrossAuditCalls(enabled: boolean) {
  const database = useLocalDatabase();
  const { scope } = useSession();
  const unitId = scope?.unitIds[0];
  const standing = useQuery({
    queryKey: ['cross-audit-calls', unitId],
    queryFn: () => api.get<CrossAuditCall[]>(`/units/${unitId}/cross-audit-calls`),
    enabled: enabled && unitId !== undefined,
  });
  const audits = useQuery({ queryKey: ['local', 'audits'], queryFn: () => listLocalAudits(database), enabled });
  return { calls: openCrossAuditCalls(standing.data ?? [], audits.data ?? []), standing };
}

/** "Zone 4A — Paint shop". */
export function crossAuditCallZone(call: CrossAuditCall): string {
  return zoneDisplayLabel(call.zoneCode, call.zoneName);
}

/** "Due 18 Oct", or "Overdue since 18 Oct" once the day has passed. */
export function crossAuditDue(call: CrossAuditCall): string {
  return `${isOverdue(call) ? 'Overdue since' : 'Due'} ${formatDayMonth(`${call.dueOn}T12:00:00+05:30`)}`;
}

/** R-73: "Assigned to you", "Assigned to Asha Rao", or null for a call to every Zone Leader. */
export function crossAuditAssignee(
  item: { assigneeUserId?: string | null; assigneeName?: string | null },
  userId: string | undefined,
): string | null {
  if (item.assigneeUserId && item.assigneeUserId === userId) return 'Assigned to you';
  return item.assigneeName ? `Assigned to ${item.assigneeName}` : null;
}

/** Answering a call: the selfie, then that Zone, as a cross audit. */
export function crossAuditStart(call: CrossAuditCall): Href {
  return { pathname: '/audit/start', params: { type: 'CROSS_5S', zoneId: call.zoneId } };
}
