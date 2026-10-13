import { useQuery } from '@tanstack/react-query';
import type { Href } from 'expo-router';
import type { NotificationPage } from '@audit5s/contracts';
import { zoneDisplayLabel } from '@audit5s/domain';
import { api } from '../lib/api';
import { crossAuditCallZoneId, openCrossAuditCalls } from '../lib/cross-audit-call';
import { listLocalAudits } from '../lib/db/audit.repository';
import { useLocalDatabase } from '../lib/db/provider';

export type CrossAuditCall = NotificationPage['data'][number];

/**
 * A Zone Leader's open cross-audit calls, newest first: the Overview's blue row and the list
 * behind it. Online only, and quiet when it fails: offline the calls just don't show.
 */
export function useOpenCrossAuditCalls(enabled: boolean) {
  const database = useLocalDatabase();
  const notifications = useQuery({
    queryKey: ['notifications', 'cross-audit'],
    queryFn: () => api.get<NotificationPage>('/notifications?limit=50'),
    enabled,
  });
  const audits = useQuery({ queryKey: ['local', 'audits'], queryFn: () => listLocalAudits(database), enabled });
  return { calls: openCrossAuditCalls(notifications.data?.data ?? [], audits.data ?? []), notifications };
}

/** "Zone 4A — Paint shop"; "Any Zone" for a call made before calls named one. */
export function crossAuditCallZone(call: CrossAuditCall): string {
  return typeof call.data.zoneCode === 'string'
    ? zoneDisplayLabel(call.data.zoneCode, String(call.data.zoneName ?? ''))
    : 'Any Zone';
}

/** Answering a call: the selfie, then that Zone, as a cross audit. */
export function crossAuditStart(call: CrossAuditCall): Href {
  const zoneId = crossAuditCallZoneId(call);
  return { pathname: '/audit/start', params: zoneId ? { type: 'CROSS_5S', zoneId } : { type: 'CROSS_5S' } };
}
