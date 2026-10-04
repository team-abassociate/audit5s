import { NOTIFICATION_EVENT_TYPES, type NotificationPage } from '@audit5s/contracts';
import { HINDI_ZONE, LONG_PERSON, LONG_UNIT, uuid } from '@/features/audit-log/worst-case';

const TYPES = ['audit', 'corrective_action', 'device', 'user', 'report', null] as const;

/** Dev-only worst case for Notifications (`?data=worst`): 100 items, long titles, Hindi Zone names. */
export function worstNotifications(): NotificationPage {
  const data = Array.from({ length: 100 }, (_, i) => ({
    id: uuid(i),
    eventType: NOTIFICATION_EVENT_TYPES[i % NOTIFICATION_EVENT_TYPES.length]!,
    title:
      i % 3 === 0
        ? 'A'
        : `${LONG_PERSON} completed an external 5S audit at ${LONG_UNIT} — ${HINDI_ZONE}`,
    body: i % 2 ? `Overdue: Zone Z-17 ${HINDI_ZONE} — 1,284 corrective actions are past due. ${'x'.repeat(80)}` : '',
    data: {},
    unitId: null,
    resourceType: TYPES[i % TYPES.length]!,
    resourceId: i % 6 === 5 ? null : uuid(1000 + i),
    readAt: i % 2 ? null : '2026-09-30T09:00:00.000Z',
    createdAt: new Date(Date.UTC(2026, 8, 30, 9, 0) - i * 360_000).toISOString(),
  }));
  return { data, nextCursor: 'more', unreadCount: 1284 };
}
