import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Notification,
  NotificationChannel,
  NotificationEventType,
  NotificationPage,
  NotificationPreferences,
} from '@audit5s/contracts';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button, Card, CardHeader, ErrorNotice, Spinner, Table, Td, Th } from '@/components/ui';

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
          {page.data?.data.map((notification) => (
            <li key={notification.id}>
              <button
                type="button"
                className={cn(
                  'w-full px-4 py-3 text-left hover:bg-board',
                  !notification.readAt && 'bg-tile-2',
                )}
                onClick={() => !notification.readAt && markRead.mutate(notification.id)}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className={cn('text-sm', !notification.readAt && 'font-semibold')}>
                    {notification.title}
                  </span>
                  <span className="shrink-0 text-xs text-ink-3">
                    {new Date(notification.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-sm text-ink-2">{notification.body}</p>
              </button>
            </li>
          ))}
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
