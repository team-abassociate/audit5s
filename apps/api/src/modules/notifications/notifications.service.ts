import { Injectable } from '@nestjs/common';
import {
  NOTIFICATION_EVENT_TYPES,
  type ListNotificationsQuery,
  type Notification,
  type NotificationPage,
  type NotificationPreference,
  type NotificationPreferences,
  type UpdateNotificationPreferencesRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { NotificationsRepository, type NotificationRow } from './notifications.repository';

/** The channels a preference grid shows. EMAIL is in §5.1's enum and nowhere wired. */
const PREFERENCE_CHANNELS = ['IN_APP', 'WHATSAPP', 'SMS'] as const;

/**
 * The notification centre and its preferences (§8.10). Reading is the whole of it: the
 * rows are written by the worker, never by a request.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly repository: NotificationsRepository) {}

  async list(scope: ScopeContext, query: ListNotificationsQuery): Promise<NotificationPage> {
    const rows = await this.repository.list(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      data: page.map(toNotification),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      unreadCount: await this.repository.unreadCount(scope),
    };
  }

  async markRead(scope: ScopeContext, notificationId: string): Promise<Notification> {
    const row = await this.repository.markRead(scope, notificationId);
    if (!row) throw AppError.notFound('No such notification');
    return toNotification(row);
  }

  async markAllRead(scope: ScopeContext): Promise<{ updated: number }> {
    return { updated: await this.repository.markAllRead(scope) };
  }

  /** Every event type × channel, defaults filled in; IN_APP is always on (§5.9). */
  async preferences(scope: ScopeContext): Promise<NotificationPreferences> {
    const saved = new Map(
      (await this.repository.preferences(scope)).map((row) => [`${row.eventType}:${row.channel}`, row.enabled]),
    );
    return {
      preferences: NOTIFICATION_EVENT_TYPES.flatMap((eventType) =>
        PREFERENCE_CHANNELS.map((channel) => ({
          eventType,
          channel,
          enabled: channel === 'IN_APP' ? true : (saved.get(`${eventType}:${channel}`) ?? true),
        })),
      ),
    };
  }

  async updatePreferences(
    scope: ScopeContext,
    request: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferences> {
    // "IN_APP always": a request to switch it off is ignored rather than refused, so a
    // client sending the whole grid back does not have to know which cells are locked.
    const changes: NotificationPreference[] = request.preferences.filter(
      (preference) => preference.channel !== 'IN_APP',
    );
    await this.repository.savePreferences(scope, changes);
    return this.preferences(scope);
  }
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    eventType: row.eventType as Notification['eventType'],
    title: row.title,
    body: row.body,
    data: (row.data ?? {}) as Record<string, unknown>,
    unitId: row.unitId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
