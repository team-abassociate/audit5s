import { z } from 'zod';
import { booleanQuery, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from './common';
import { notificationChannelSchema } from './enums';

/**
 * Notifications (ARCHITECTURE.md §4.2, §5.9, §8.10).
 *
 * The event types are §4.2's, restricted to those with a notification consumer and a
 * source that exists. `REPORT_GENERATED` joined in Phase 7, when the reports module gave
 * it a source; `EVIDENCE_ATTACHED` and `PERMISSION_CHANGED` have no notification consumer
 * at all.
 */
export const NOTIFICATION_EVENT_TYPES = [
  'UNIT_ASSIGNED',
  'UNIT_ACCESS_REVOKED',
  'AUDIT_ASSIGNED',
  'AUDIT_STARTED',
  'AUDIT_PAUSED',
  'AUDIT_COMPLETED',
  'CORRECTIVE_ACTION_SUBMITTED',
  'CORRECTIVE_ACTION_VERIFIED',
  'CORRECTIVE_ACTION_REOPENED',
  'SYNC_FAILURE',
  'CHECKLIST_PUBLISHED',
  'REPORT_GENERATED',
] as const;
export const notificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);
export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>;

export const notificationSchema = z.object({
  id: uuidSchema,
  eventType: notificationEventTypeSchema,
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()),
  unitId: uuidSchema.nullable(),
  resourceType: z.string().nullable(),
  resourceId: uuidSchema.nullable(),
  readAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type Notification = z.infer<typeof notificationSchema>;

export const listNotificationsQuerySchema = paginationQuerySchema.extend({
  unread: booleanQuery(false),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

/** A page of the notification centre, with the badge count alongside it. */
export const notificationPageSchema = z.object({
  data: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const notificationPreferenceSchema = z.object({
  eventType: notificationEventTypeSchema,
  channel: notificationChannelSchema,
  enabled: z.boolean(),
});
export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;

/**
 * `GET /notification-preferences` answers every event type × channel, defaults filled in,
 * so a client renders the whole grid without knowing the defaults. `IN_APP` is always
 * enabled (§5.9: "IN_APP always") and a request to switch it off is ignored.
 */
export const notificationPreferencesSchema = z.object({
  preferences: z.array(notificationPreferenceSchema),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferencesRequestSchema = z.object({
  preferences: z.array(notificationPreferenceSchema).min(1).max(100),
});
export type UpdateNotificationPreferencesRequest = z.infer<
  typeof updateNotificationPreferencesRequestSchema
>;
