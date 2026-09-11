import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
  notificationDeliveries,
  notificationPreferences,
  notifications,
  users,
  type Database,
} from '@audit5s/db';
import type {
  ListNotificationsQuery,
  NotificationChannel,
  NotificationPreference,
  NotificationStatus,
  Role,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import type { DomainEventJob } from '../../infrastructure/queue/domain-events';
import { setActorContext } from '../users/users.repository';

/** Everything here is the actor's own (PART 6: `own_record` for all four roles). */
const ownColumns = { recordUserId: notifications.recipientUserId };

export interface NotificationTarget {
  userId: string;
  role: Role;
  whatsappEnabled: boolean;
  smsEnabled: boolean;
}

export type DeliveryRow = typeof notificationDeliveries.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;

@Injectable()
export class NotificationsRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  // ----------------------------------------------------------- the worker's writes

  /** 0009's `app_notification_targets()`: ids, roles and two switches, nothing more. */
  async targets(
    eventType: string,
    unitId: string | null,
    roles: Role[],
    userIds: string[],
  ): Promise<NotificationTarget[]> {
    const result = await this.db.execute(sql`
      SELECT user_id, user_role, whatsapp_enabled, sms_enabled
        FROM app_notification_targets(
          ${eventType},
          ${unitId}::uuid,
          ${`{${roles.join(',')}}`}::role[],
          ${`{${userIds.join(',')}}`}::uuid[])`);
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({
      userId: String(row.user_id),
      role: row.user_role as Role,
      whatsappEnabled: Boolean(row.whatsapp_enabled),
      smsEnabled: Boolean(row.sms_enabled),
    }));
  }

  /**
   * The notification, its IN_APP delivery and the first external one, written **as the
   * recipient** — so the rows stay behind own-record policies — and idempotent on the
   * event: a redelivered job finds what the first delivery wrote.
   */
  async recordForRecipient(
    target: NotificationTarget,
    event: DomainEventJob,
    message: { title: string; body: string },
    external: 'WHATSAPP' | 'SMS' | null,
  ): Promise<{ notificationId: string; phoneE164: string | null; deliveries: DeliveryRow[] }> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, target.userId, target.role);

      await tx
        .insert(notifications)
        .values({
          eventId: event.eventId,
          recipientUserId: target.userId,
          eventType: event.type,
          title: message.title,
          body: message.body,
          data: event.data,
          unitId: event.unitId,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
        })
        .onConflictDoNothing({ target: [notifications.eventId, notifications.recipientUserId] });

      const [notification] = await tx
        .select({ id: notifications.id, phoneE164: users.phoneE164 })
        .from(notifications)
        .innerJoin(users, eq(users.id, notifications.recipientUserId))
        .where(and(eq(notifications.eventId, event.eventId), eq(notifications.recipientUserId, target.userId)))
        .limit(1);

      const channels: NotificationChannel[] = ['IN_APP', ...(external ? [external] : [])];
      await tx
        .insert(notificationDeliveries)
        .values(channels.map((channel) => ({ notificationId: notification!.id, channel })))
        .onConflictDoNothing({
          target: [notificationDeliveries.notificationId, notificationDeliveries.channel],
        });

      const deliveries = await tx
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.notificationId, notification!.id));

      return { notificationId: notification!.id, phoneE164: notification!.phoneE164, deliveries };
    });
  }

  /** §5.9's fallback row: an SMS pointing at the WhatsApp delivery that did not arrive. */
  async ensureFallback(
    target: NotificationTarget,
    notificationId: string,
    failedDeliveryId: string,
  ): Promise<DeliveryRow> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, target.userId, target.role);
      await tx
        .insert(notificationDeliveries)
        .values({ notificationId, channel: 'SMS', fallbackOfDeliveryId: failedDeliveryId })
        .onConflictDoNothing({
          target: [notificationDeliveries.notificationId, notificationDeliveries.channel],
        });
      const [row] = await tx
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.notificationId, notificationId),
            eq(notificationDeliveries.channel, 'SMS'),
          ),
        )
        .limit(1);
      return row!;
    });
  }

  async recordAttempt(
    target: NotificationTarget,
    deliveryId: string,
    outcome: {
      status: NotificationStatus;
      providerMessageId?: string | null;
      lastError?: string | null;
      countsAsAttempt: boolean;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, target.userId, target.role);
      const now = new Date();
      await tx
        .update(notificationDeliveries)
        .set({
          status: outcome.status,
          providerMessageId: outcome.providerMessageId ?? null,
          lastError: outcome.lastError ?? null,
          ...(outcome.countsAsAttempt
            ? { attemptCount: sql`${notificationDeliveries.attemptCount} + 1` }
            : {}),
          ...(outcome.status === 'SENT' ? { sentAt: now } : {}),
          ...(outcome.status === 'DELIVERED' ? { sentAt: now, deliveredAt: now } : {}),
        })
        .where(eq(notificationDeliveries.id, deliveryId));
    });
  }

  // ----------------------------------------------------------------- the API's reads

  async list(scope: ScopeContext, query: ListNotificationsQuery): Promise<NotificationRow[]> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const filters: Array<SQL | undefined> = [
        query.unread ? isNull(notifications.readAt) : undefined,
        // Newest first, and the id is not time-ordered: the cursor is the row's position.
        query.cursor
          ? sql`(${notifications.createdAt}, ${notifications.id}) < (
              SELECT n.created_at, n.id FROM notification n WHERE n.id = ${query.cursor}::uuid)`
          : undefined,
      ];
      return tx
        .select()
        .from(notifications)
        .where(this.scoped(scope, ownColumns, ...filters))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit + 1);
    });
  }

  async unreadCount(scope: ScopeContext): Promise<number> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(this.scoped(scope, ownColumns, isNull(notifications.readAt)));
      return row?.count ?? 0;
    });
  }

  /** Idempotent: a second read keeps the first `read_at`. */
  async markRead(scope: ScopeContext, notificationId: string): Promise<NotificationRow | null> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          this.scoped(scope, ownColumns, eq(notifications.id, notificationId), isNull(notifications.readAt)),
        );
      const [row] = await tx
        .select()
        .from(notifications)
        .where(this.scoped(scope, ownColumns, eq(notifications.id, notificationId)))
        .limit(1);
      return row ?? null;
    });
  }

  async markAllRead(scope: ScopeContext): Promise<number> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const rows = await tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(this.scoped(scope, ownColumns, isNull(notifications.readAt)))
        .returning({ id: notifications.id });
      return rows.length;
    });
  }

  async preferences(scope: ScopeContext): Promise<NotificationPreference[]> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const rows = await tx
        .select({
          eventType: notificationPreferences.eventType,
          channel: notificationPreferences.channel,
          enabled: notificationPreferences.enabled,
        })
        .from(notificationPreferences)
        .where(this.scoped(scope, { recordUserId: notificationPreferences.userId }));
      return rows as NotificationPreference[];
    });
  }

  async savePreferences(scope: ScopeContext, preferences: NotificationPreference[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      for (const preference of preferences) {
        await tx
          .insert(notificationPreferences)
          .values({ userId: scope.actor.userId, ...preference })
          .onConflictDoUpdate({
            target: [
              notificationPreferences.userId,
              notificationPreferences.eventType,
              notificationPreferences.channel,
            ],
            set: { enabled: preference.enabled },
          });
      }
    });
  }
}
