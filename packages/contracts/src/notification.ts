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
 *
 * `DATA_INTEGRITY_ALERT` is not one of §4.2's — it is raised by the nightly sweep rather
 * than by a domain write, and it is how §16.4's findings reach a Super Admin at all
 * (`DECISIONS.md` R-17). It is in this list because the fan-out is the transport: the
 * notification row is both the delivery and the durable record of the finding.
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
  /** R-31: a correction to a completed audit raised a new finding. */
  'CORRECTIVE_ACTION_OPENED',
  /** R-31: a correction to a completed audit took a finding away. */
  'CORRECTIVE_ACTION_WITHDRAWN',
  'CORRECTIVE_ACTION_OVERDUE',
  'SYNC_FAILURE',
  'CHECKLIST_PUBLISHED',
  'REPORT_GENERATED',
  'DATA_INTEGRITY_ALERT',
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

const countSchema = z.number().int().nonnegative();

/**
 * `CORRECTIVE_ACTION_OVERDUE`'s `data` since D10: one notification per Zone and leader for
 * everything of theirs that fell overdue that night, instead of one per item. Per leader as
 * well as per Zone because a Zone Leader may read only the actions assigned to them, so a
 * bundle never carries somebody else's. Rows written before D10 carry one item's fields
 * flat and fail this parse; a reader then shows the title and body alone.
 */
export const overdueBundleDataSchema = z.object({
  zoneId: uuidSchema,
  zoneCode: z.string(),
  zoneName: z.string(),
  /** The Zone's leader as the actions record them — an account's name or a typed one. */
  assigneeName: z.string().nullable(),
  items: z
    .array(
      z.object({
        actionId: uuidSchema,
        questionNo: z.number().int().nullable(),
        /** R-38: an overall action has no question; its place in the auditor's list names it. */
        suggestionNo: z.number().int().nullable(),
        daysOverdue: countSchema,
      }),
    )
    .min(1),
});
export type OverdueBundleData = z.infer<typeof overdueBundleDataSchema>;

/**
 * `DATA_INTEGRITY_ALERT`'s `data` since D10: one nightly summary across every Unit, naming
 * only the Units with a finding (R-17b — an all-clear night sends nothing).
 */
export const integrityDigestDataSchema = z.object({
  /** The night the checks ran, as the organisation's calendar date (`YYYY-MM-DD`). */
  night: z.iso.date(),
  units: z
    .array(
      z.object({
        unitId: uuidSchema,
        unitName: z.string(),
        orphanEvidence: countSchema,
        staleAudits: countSchema,
        unsyncedDevices: countSchema,
        scoreDrift: countSchema,
        auditsSampled: countSchema,
      }),
    )
    .min(1),
});
export type IntegrityDigestData = z.infer<typeof integrityDigestDataSchema>;

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
