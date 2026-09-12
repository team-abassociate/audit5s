import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { notificationChannelEnum, notificationStatusEnum } from './enums';
import { units, users } from './identity';

/** Notifications (ARCHITECTURE.md §5.9). Each row is written as its recipient (0009). */
export const notifications = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** The domain event that raised it; with the recipient, the redelivery dedupe key. */
    eventId: uuid('event_id').notNull(),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'restrict' }),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('notification_event_recipient_key').on(table.eventId, table.recipientUserId),
    index('notification_centre_idx').on(table.recipientUserId, table.readAt, table.createdAt),
  ],
);

export const notificationDeliveries = pgTable(
  'notification_delivery',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'restrict' }),
    channel: notificationChannelEnum('channel').notNull(),
    status: notificationStatusEnum('status').notNull().default('PENDING'),
    /** An SMS sent because WhatsApp failed points at the failure (§5.9). */
    fallbackOfDeliveryId: uuid('fallback_of_delivery_id').references(
      (): AnyPgColumn => notificationDeliveries.id,
      { onDelete: 'restrict' },
    ),
    providerMessageId: text('provider_message_id'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('notification_delivery_channel_key').on(table.notificationId, table.channel),
  ],
);

export const notificationPreferences = pgTable(
  'notification_preference',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    enabled: boolean('enabled').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('notification_preference_key').on(table.userId, table.eventType, table.channel),
  ],
);
