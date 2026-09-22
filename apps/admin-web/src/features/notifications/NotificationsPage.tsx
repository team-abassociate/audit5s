import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Notification,
  NotificationChannel,
  NotificationEventType,
  NotificationPage,
  NotificationPreferences,
} from '@audit5s/contracts';
import { Link } from '@tanstack/react-router';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button, Card, CardHeader, ErrorNotice, Spinner, Table, Td, Th } from '@/components/ui';


/** The tabs a notification can send someone to. */
type NotificationTarget =
  | '/audits'
  | '/corrective-actions'
  | '/reports'
  | '/checklists'
  | '/units'
  | '/users'
  | '/sync'
  | '/dashboard';

const TARGET_LABEL: Record<NotificationTarget, string> = {
  '/audits': 'audits',
  '/corrective-actions': 'corrective actions',
  '/reports': 'reports',
  '/checklists': 'checklists',
  '/units': 'units & zones',
  '/users': 'users',
  '/sync': 'sync health',
  '/dashboard': 'dashboard',
};

const EVENT_LABEL: Record<NotificationEventType, string> = {
  UNIT_ASSIGNED: 'Unit access',
  UNIT_ACCESS_REVOKED: 'Unit access',
  AUDIT_ASSIGNED: 'Audit',
  AUDIT_STARTED: 'Audit',
  AUDIT_PAUSED: 'Audit',
  AUDIT_COMPLETED: 'Audit',
  CORRECTIVE_ACTION_SUBMITTED: 'Corrective action',
  CORRECTIVE_ACTION_VERIFIED: 'Corrective action',
  CORRECTIVE_ACTION_REOPENED: 'Corrective action',
  CORRECTIVE_ACTION_OPENED: 'Corrective action',
  CORRECTIVE_ACTION_WITHDRAWN: 'Corrective action',
  CORRECTIVE_ACTION_OVERDUE: 'Overdue',
  SYNC_FAILURE: 'Sync',
  CHECKLIST_PUBLISHED: 'Checklist',
  REPORT_GENERATED: 'Report',
  DATA_INTEGRITY_ALERT: 'Integrity',
};

/**
 * Where a notification leads.
 *
 * Keyed on `resourceType` — what the event is *about* — and only falling back to the
 * event type when the row carries no resource. The routes are flat, so this lands on the
 * right tab rather than the exact record; that is still the difference between one click
 * and a hunt.
 */
function notificationTarget(notification: Notification): NotificationTarget {
  switch (notification.resourceType) {
    case 'audit':
    case 'audit_assignment':
      return '/audits';
    case 'corrective_action':
      return '/corrective-actions';
    case 'report':
    case 'report_access_token':
      return '/reports';
    case 'checklist_template':
    case 'checklist_version':
      return '/checklists';
    case 'unit':
    case 'unit_membership':
    case 'zone':
      return '/units';
    case 'user':
      return '/users';
    case 'sync_conflict':
    case 'device':
      return '/sync';
    default:
      // No resource, or one this build does not know: fall back on the event itself, and
      // failing that the dashboard, which is never a wrong place to arrive.
      return notification.eventType === 'SYNC_FAILURE'
        ? '/sync'
        : notification.eventType === 'DATA_INTEGRITY_ALERT'
          ? '/dashboard'
          : '/dashboard';
  }
}

/**
 * The notification centre and its preferences (§8.10). In-app is always on (§5.9); what a
 * person chooses is whether WhatsApp and SMS reach them too.
 */
export function NotificationsPage() {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const page = useQuery({
    queryKey: ['notifications', unreadOnly],
    queryFn: () => api.get<NotificationPage>(`/notifications?limit=100${unreadOnly ? '&unread=true' : ''}`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const markRead = useMutation({
    mutationFn: (id: string) => api.post<Notification>(`/notifications/${id}/read`),
    onSuccess: invalidate,
  });
  const markAll = useMutation({
    mutationFn: () => api.post<{ updated: number }>('/notifications/read-all'),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Notifications"
          description={page.data ? `${page.data.unreadCount} unread` : undefined}
          action={
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setUnreadOnly((value) => !value)}>
                {unreadOnly ? 'Show all' : 'Unread only'}
              </Button>
              <Button
                variant="secondary"
                disabled={!page.data?.unreadCount || markAll.isPending}
                onClick={() => markAll.mutate()}
              >
                Mark all read
              </Button>
            </div>
          }
        />
        {page.isLoading && <Spinner />}
        {page.error && (
          <div className="p-4">
            <ErrorNotice error={page.error} />
          </div>
        )}
        {page.data && page.data.data.length === 0 && (
          <p className="px-4 py-4 text-sm text-ink-3">Nothing here.</p>
        )}
        <ul className="divide-y divide-edge-soft">
          {page.data?.data.map((notification) => {
            const target = notificationTarget(notification);
            return (
              <li key={notification.id}>
                {/*
                  The whole row is the link. A notification that says something happened
                  and then makes you find it yourself has done half its job — and the half
                  it skipped is the one that takes the reader the longest.
                */}
                <Link
                  to={target}
                  className={cn(
                    'flex w-full items-start gap-3 px-4 py-3 text-left no-underline hover:bg-board',
                    !notification.readAt && 'bg-tile-2',
                  )}
                  onClick={() => !notification.readAt && markRead.mutate(notification.id)}
                >
                  {/* Unread is a dot, not only a background tint: a tint alone disappears
                      on a projector and against a dark theme's own surfaces. */}
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 h-2 w-2 shrink-0',
                      notification.readAt ? 'bg-transparent' : 'bg-crit',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className={cn('text-sm', !notification.readAt && 'font-semibold')}>
                        {notification.title}
                      </span>
                      <span className="shrink-0 text-xs text-ink-3">
                        {new Date(notification.createdAt).toLocaleString()}
                      </span>
                    </span>
                    <span className="block text-sm text-ink-2">{notification.body}</span>
                    <span className="mt-1 flex items-center gap-2">
                      <span className="gb-chip gb-chip--muted">
                        {EVENT_LABEL[notification.eventType]}
                      </span>
                      <span className="text-xs text-ink-3">
                        Open {TARGET_LABEL[target]} →
                      </span>
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>

      <Preferences />
    </div>
  );
}

function Preferences() {
  const queryClient = useQueryClient();
  const grid = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api.get<NotificationPreferences>('/notification-preferences'),
  });
  const save = useMutation({
    mutationFn: (change: { eventType: NotificationEventType; channel: NotificationChannel; enabled: boolean }) =>
      api.put<NotificationPreferences>('/notification-preferences', { preferences: [change] }),
    onSuccess: (next) => queryClient.setQueryData(['notification-preferences'], next),
  });

  if (grid.isLoading) return <Spinner />;
  if (grid.error) return <ErrorNotice error={grid.error} />;

  const enabled = new Map(
    grid.data!.preferences.map((cell) => [`${cell.eventType}:${cell.channel}`, cell.enabled]),
  );
  const events = [...new Set(grid.data!.preferences.map((cell) => cell.eventType))];

  return (
    <Card>
      <CardHeader
        title="Delivery preferences"
        description="In-app is always on. WhatsApp and SMS go only to the events that use them; with no provider connected, they are recorded as skipped."
      />
      {save.error && (
        <div className="p-4">
          <ErrorNotice error={save.error} />
        </div>
      )}
      <Table>
        <thead>
          <tr>
            <Th>Event</Th>
            <Th>In-app</Th>
            <Th>WhatsApp</Th>
            <Th>SMS</Th>
          </tr>
        </thead>
        <tbody>
          {events.map((eventType) => (
            <tr key={eventType}>
              <Td>{eventType.replaceAll('_', ' ').toLowerCase()}</Td>
              {(['IN_APP', 'WHATSAPP', 'SMS'] as const).map((channel) => (
                <Td key={channel}>
                  <input
                    type="checkbox"
                    aria-label={`${eventType} ${channel}`}
                    checked={enabled.get(`${eventType}:${channel}`) ?? true}
                    disabled={channel === 'IN_APP' || save.isPending}
                    onChange={(event) => save.mutate({ eventType, channel, enabled: event.target.checked })}
                  />
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
