import { z } from 'zod';

/**
 * The enum vocabulary of ARCHITECTURE.md §5.1, defined once.
 *
 * These are the PostgreSQL enum types verbatim. `packages/db` builds its `pgEnum`s from
 * these arrays, so the database and the wire format cannot drift.
 */

export const ROLES = ['SUPER_ADMIN', 'CONSULTANT', 'COORDINATOR', 'ZONE_LEADER'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'DISABLED', 'LOCKED'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const MEMBERSHIP_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const AUDIT_TYPES = ['EXTERNAL_5S', 'CROSS_5S', 'WALK_BY'] as const;
export const auditTypeSchema = z.enum(AUDIT_TYPES);
export type AuditType = z.infer<typeof auditTypeSchema>;

export const AUDIT_STATUSES = [
  'ASSIGNED',
  'READY',
  'IN_PROGRESS',
  'PAUSED',
  'COMPLETED',
  'CORRECTIVE_ACTION_OPEN',
  'PARTIALLY_CLOSED',
  'CLOSED',
  'CANCELLED',
] as const;
export const auditStatusSchema = z.enum(AUDIT_STATUSES);
export type AuditStatus = z.infer<typeof auditStatusSchema>;

export const AUDIT_ZONE_STATUSES = ['DRAFT', 'IN_PROGRESS', 'COMPLETED'] as const;
export const auditZoneStatusSchema = z.enum(AUDIT_ZONE_STATUSES);
export type AuditZoneStatus = z.infer<typeof auditZoneStatusSchema>;

export const ASSIGNMENT_STATUSES = [
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
] as const;
export const assignmentStatusSchema = z.enum(ASSIGNMENT_STATUSES);
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;

export const S_SECTIONS = [
  'S1_SORT',
  'S2_SET_IN_ORDER',
  'S3_SHINE',
  'S4_STANDARDIZE',
  'S5_SUSTAIN',
] as const;
export const sSectionSchema = z.enum(S_SECTIONS);
export type SSection = z.infer<typeof sSectionSchema>;

/**
 * `NA` is not a number, which is why this is an enum and not an integer (ARCHITECTURE.md
 * §5.1). The numeric weight is derived by `packages/domain`, so client and server cannot
 * disagree about it.
 */
export const RESPONSE_VALUES = ['SCORE_2', 'SCORE_1', 'SCORE_0', 'NA'] as const;
export const responseValueSchema = z.enum(RESPONSE_VALUES);
export type ResponseValue = z.infer<typeof responseValueSchema>;

export const EVIDENCE_CLASSIFICATIONS = ['GOOD', 'NONCONFORMITY', 'NEUTRAL'] as const;
export const evidenceClassificationSchema = z.enum(EVIDENCE_CLASSIFICATIONS);
export type EvidenceClassification = z.infer<typeof evidenceClassificationSchema>;

export const EVIDENCE_KINDS = [
  'AUDITOR_SELFIE',
  'QUESTION_EVIDENCE',
  'WALK_BY_PHOTO',
  'CORRECTIVE_AFTER',
] as const;
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const SYNC_STATES = ['LOCAL_ONLY', 'PENDING', 'SYNCING', 'SYNCED', 'FAILED'] as const;
export const syncStateSchema = z.enum(SYNC_STATES);
export type SyncState = z.infer<typeof syncStateSchema>;

export const CORRECTIVE_ACTION_STATUSES = [
  'OPEN',
  'ACTION_SUBMITTED',
  'NOT_POSSIBLE',
  'VERIFIED',
  'REOPENED',
  /**
   * The finding it answered is gone (R-31).
   *
   * An auditor corrected the mark this action rests on — a 0 that should have been a 2 —
   * so the photograph is no longer a nonconformity and there is nothing to fix. It is
   * deliberately not `VERIFIED`: nobody fixed anything, and a closure rate that counted
   * withdrawn findings as fixed would be measuring the auditor's typing.
   *
   * The row is kept, like every other row here. An action that was raised and withdrawn is
   * part of the audit's history even though it asks nothing of anyone.
   */
  'WITHDRAWN',
] as const;
export const correctiveActionStatusSchema = z.enum(CORRECTIVE_ACTION_STATUSES);
export type CorrectiveActionStatus = z.infer<typeof correctiveActionStatusSchema>;

export const CORRECTIVE_OPTIONS = ['COMPLETED', 'NOT_POSSIBLE'] as const;
export const correctiveOptionSchema = z.enum(CORRECTIVE_OPTIONS);
export type CorrectiveOption = z.infer<typeof correctiveOptionSchema>;

export const CHECKLIST_VERSION_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'SUPERSEDED',
  'ARCHIVED',
] as const;
export const checklistVersionStatusSchema = z.enum(CHECKLIST_VERSION_STATUSES);
export type ChecklistVersionStatus = z.infer<typeof checklistVersionStatusSchema>;

export const IMPORT_JOB_STATUSES = [
  'UPLOADED',
  'VALIDATING',
  'PREVIEW',
  'FAILED',
  'COMMITTED',
  'CANCELLED',
] as const;
export const importJobStatusSchema = z.enum(IMPORT_JOB_STATUSES);
export type ImportJobStatus = z.infer<typeof importJobStatusSchema>;

export const REPORT_KINDS = ['INITIAL_ZONE', 'AFTER_EVIDENCE_ZONE', 'MULTI_ZONE_SUMMARY'] as const;
export const reportKindSchema = z.enum(REPORT_KINDS);
export type ReportKind = z.infer<typeof reportKindSchema>;

export const REPORT_STATUSES = ['QUEUED', 'RENDERING', 'READY', 'FAILED'] as const;
export const reportStatusSchema = z.enum(REPORT_STATUSES);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

export const NOTIFICATION_CHANNELS = ['IN_APP', 'WHATSAPP', 'SMS', 'EMAIL'] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED'] as const;
export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

export const LOCATION_PROVIDERS = ['GPS', 'NETWORK', 'FUSED', 'UNKNOWN'] as const;
export const locationProviderSchema = z.enum(LOCATION_PROVIDERS);
export type LocationProvider = z.infer<typeof locationProviderSchema>;
