import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  NOTIFICATION_EVENT_TYPES,
  overdueBundleDataSchema,
  type Notification,
  type NotificationPage,
} from '@audit5s/contracts';
import { Link } from '@tanstack/react-router';
import { formatDateTime } from '@audit5s/domain';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { NOTIFICATION_CATEGORY_LABEL, NOTIFICATION_EVENT_LABEL } from '@/lib/labels';
import { Button, Card, CardHeader, EmptyState, ErrorNotice, Skeleton, Table, Th } from '@/components/ui';
import { isWorstCase } from '@/features/audit-log/worst-case';
import { worstNotifications } from './worst-case';

/**
 * Where a notification leads (N3): the exact record where its page can open one — the
 * audit, the assignment, the person, the phone's held work — and otherwise the page itself.
 *
 * Keyed on `resourceType` — what the event is *about* — and only falling back to the
 * event type when the row carries no resource.
 */
function notificationLink(n: Notification) {
  const id = n.resourceId ?? undefined;
  switch (n.resourceType) {
    case 'audit':
      return { to: '/audits', search: { audit: id } } as const;
    case 'audit_assignment':
      return { to: '/audits', search: { assignment: id } } as const;
    case 'user':
      return { to: '/users', search: { user: id } } as const;
    case 'device':
      return { to: '/sync', search: { device: id } } as const;
    case 'sync_conflict':
      return { to: '/sync' } as const;
    case 'corrective_action':
      return { to: '/corrective-actions', search: { action: id } } as const;
    // ponytail: the report and checklist pages have no per-record address yet (S11);
    // these open the page, and should name the record once those routes exist.
    case 'report':
    case 'report_access_token':
      return { to: '/reports' } as const;
    case 'checklist_template':
    case 'checklist_version':
      return { to: '/checklists' } as const;
    case 'zone':
      // D10: a Zone's overdue bundle opens that Unit's overdue list, by leader.
      if (n.eventType === 'CORRECTIVE_ACTION_OVERDUE') {
        return {
          to: '/corrective-actions',
          search: { overdue: true, group: 'leader', ...(n.unitId ? { unit: n.unitId } : {}) },
        } as const;
      }
      return { to: '/units' } as const;
    case 'unit':
    case 'unit_membership':
      return { to: '/units' } as const;
    default:
      // No resource, or one this build does not know: the event's own page, and failing
      // that the dashboard, which is never a wrong place to arrive.
      // The nightly data check is about uploads and phones that went quiet: Sync health.
      return {
        to: n.eventType === 'SYNC_FAILURE' || n.eventType === 'DATA_INTEGRITY_ALERT' ? '/sync' : '/dashboard',
      } as const;
  }
}

/**
 * The notification centre and its delivery settings (§8.10). In-app is always on (§5.9);
 * WhatsApp and SMS are not wired at MVP (STACK §2), and the page says so (N5).
 */
export function NotificationsPage() {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const page = useQuery({
    queryKey: ['notifications', unreadOnly],
    queryFn: () =>
      isWorstCase()
        ? Promise.resolve(worstNotifications())
        : api.get<NotificationPage>(`/notifications?limit=100${unreadOnly ? '&unread=true' : ''}`),
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

  const shown = page.data?.data.length ?? 0;
  const description = page.data
    ? `${page.data.unreadCount.toLocaleString('en-IN')} unread` +
      (page.data.nextCursor ? ` · showing the newest ${shown}` : '')
    : undefined;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Notifications"
          description={description}
          action={
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" aria-pressed={unreadOnly} onClick={() => setUnreadOnly((value) => !value)}>
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
        {page.isLoading && <Skeleton variant="rows" columns={['Notification', 'When']} label="Loading notifications…" />}
        {page.error && (
          <div className="p-4">
            <ErrorNotice error={page.error} />
          </div>
        )}
        {page.data && shown === 0 ? (
          unreadOnly ? (
            <EmptyState
              title="Nothing unread."
              action={
                <Button variant="secondary" onClick={() => setUnreadOnly(false)}>
                  Show all
                </Button>
              }
            />
          ) : (
            <EmptyState title="No notifications yet.">
              Audits, corrective actions, reports and held field work are announced here.
            </EmptyState>
          )
        ) : null}
        <ul className="divide-y divide-edge-soft">
          {page.data?.data.map((notification) => {
            const unread = !notification.readAt;
            return (
              <li
                key={notification.id}
                className={cn('flex items-start gap-3 px-4 py-3', unread && 'bg-tile-2')}
              >
                {/* Unread is a dot and bold type, not only a background tint: a tint alone
                    disappears on a projector and against a dark theme's own surfaces. */}
                <span aria-hidden className={cn('mt-1.5 h-2 w-2 shrink-0', unread ? 'bg-crit' : 'bg-transparent')} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    {/* The title is the link and the only one (N4): a whole-card link reads
                        every word of the card as its name. */}
                    <Link
                      {...notificationLink(notification)}
                      className={cn('min-w-0 text-sm [overflow-wrap:anywhere]', unread && 'font-semibold')}
                      onClick={() => unread && markRead.mutate(notification.id)}
                    >
                      {unread ? <span className="sr-only">Unread: </span> : null}
                      {notification.title}
                    </Link>
                    <span className="shrink-0 font-mono text-xs text-ink-3">
                      {formatDateTime(notification.createdAt)}
                    </span>
                  </div>
                  {/* pre-line: the nightly summary is a line per Unit (D10). */}
                  <p className="m-0 whitespace-pre-line text-sm text-ink-2 [overflow-wrap:anywhere]">
                    {notification.body}
                  </p>
                  <BundleItems
                    notification={notification}
                    onOpen={() => unread && markRead.mutate(notification.id)}
                  />
                  <span className="gb-chip gb-chip--muted mt-1">
                    {NOTIFICATION_CATEGORY_LABEL[notification.eventType]}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <Preferences />
    </div>
  );
}

/**
 * A Zone's overdue bundle (D10), one link per item, each opening that action (CA1's
 * `?action=`). A one-item notice already links its item from the title; a row written
 * before D10 has no items and shows nothing here.
 */
function BundleItems({ notification, onOpen }: { notification: Notification; onOpen: () => void }) {
  if (notification.eventType !== 'CORRECTIVE_ACTION_OVERDUE') return null;
  const bundle = overdueBundleDataSchema.safeParse(notification.data);
  if (!bundle.success || bundle.data.items.length < 2) return null;
  return (
    <ul aria-label="Overdue items" className="m-0 mt-1 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-sm">
      {bundle.data.items.map((item, index) => (
        <li key={item.actionId}>
          <Link
            to="/corrective-actions"
            search={{ action: item.actionId, ...(notification.unitId ? { unit: notification.unitId } : {}) }}
            className="font-mono"
            onClick={onOpen}
          >
            {/* As the Corrective actions list names an item; a walk-by has no number of its own. */}
            {item.questionNo
              ? `Q${item.questionNo}`
              : item.suggestionNo
                ? `Overall action ${item.suggestionNo}`
                : `Walk-by observation ${index + 1}`}
          </Link>
          <span className="font-mono text-xs text-ink-3">
            {' '}
            · {item.daysOverdue} day{item.daysOverdue === 1 ? '' : 's'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Delivery settings. Every event reaches the portal and the phone in-app (§5.9). WhatsApp
 * and SMS have no provider at MVP (STACK §2: "not wired"), so their columns are switched
 * off and say so, rather than showing ticks that deliver nothing (N5). They become
 * choices again when a provider is connected.
 */
function Preferences() {
  return (
    <Card>
      <CardHeader
        title="Delivery preferences"
        description="Every event arrives in-app; that cannot be switched off. WhatsApp and SMS are not connected yet, so nothing is sent on them."
      />
      <Table>
        <thead>
          <tr>
            <Th>Event</Th>
            <Th>In-app</Th>
            <Th>
              WhatsApp <span className="font-normal normal-case tracking-normal text-ink-3">· Not connected</span>
            </Th>
            <Th>
              SMS <span className="font-normal normal-case tracking-normal text-ink-3">· Not connected</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {NOTIFICATION_EVENT_TYPES.map((eventType) => {
            const event = NOTIFICATION_EVENT_LABEL[eventType];
            return (
              <tr key={eventType}>
                <td>{event}</td>
                <td>
                  <input type="checkbox" className="accent-ink" aria-label={`${event}: in-app, always on`} checked disabled readOnly />
                </td>
                <td>
                  <input type="checkbox" className="accent-ink" aria-label={`${event}: WhatsApp, not connected`} checked={false} disabled readOnly />
                </td>
                <td>
                  <input type="checkbox" className="accent-ink" aria-label={`${event}: SMS, not connected`} checked={false} disabled readOnly />
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
