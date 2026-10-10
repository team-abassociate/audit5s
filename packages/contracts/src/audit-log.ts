import { z } from 'zod';
import { isoDateTimeSchema, paginationQuerySchema, uuidSchema } from './common';
import { roleSchema } from './enums';

/**
 * The mandatory logged actions of ARCHITECTURE.md §5.9, made concrete. Adding an action
 * here is how a new administrative operation becomes auditable; the interceptor refuses an
 * action name that is not in this list, so the log cannot quietly grow an untyped vocabulary.
 */
export const AUDIT_LOG_ACTIONS = [
  'user.created',
  'user.updated',
  'user.disabled',
  /** An administrator undid a disable: the account signs in again (2026-09-28). */
  'user.enabled',
  /** Removal, as far as D8 allows: archived and disabled, never deleted (R-25). */
  'user.archived',
  'user.password_reset',
  'consultant.assigned',
  'consultant.revoked',
  'coordinator.assigned',
  'coordinator.revoked',
  /** Sectors (0018). Reference data, but who added a sector and when is worth keeping. */
  'industry.created',
  'industry.updated',
  'industry.archived',
  /** Which checklists an industry is offered changed (0042). */
  'industry.checklists_changed',
  'zone.created',
  'zone.updated',
  'zone.archived',
  'zone.leader_assigned',
  'checklist.imported',
  'checklist.translations_imported',
  /** A Super Admin corrected a Hindi or Marathi question by hand (0036). */
  'checklist.translation_updated',
  'checklist.published',
  'checklist.deactivated',
  'checklist.template_updated',
  'audit_assignment.created',
  'audit_assignment.cancelled',
  'audit.changed_after_completion',
  'audit.cancelled',
  /** §9.5 Layer 1's force-release: a Super Admin breaks a device's single-writer lock. */
  'audit.device_released',
  /** R-33: the auditor restarted their own finished audit. Written since R-33; listed 2026-10-05. */
  'audit.restarted',
  'report.generated',
  'report.token_revoked',
  /** CA9: a Super Admin made one more link to a corrective action; the printed one still works. */
  'report.token_minted',
  'report.cancelled',
  'report.removed',
  'corrective_action.verified',
  'corrective_action.reopened',
  'corrective_action.reassigned',
  /**
   * Actions a completed audit should have raised and did not, raised after the fact
   * (2026-09-30): completion ran under a Consultant's lapsed grant and saw no Zones.
   */
  'corrective_action.raised_missing',
  'evidence.redacted',
  'permission.changed',
  'unit.created',
  'unit.updated',
  'unit.archived',
  'device.revoked',
  /** An administrator cleared a revoked phone; its people sign in on it again (2026-09-28). */
  'device.restored',
  /**
   * Before 0025: a handset changed hands, and login moved it to the new user. Kept so the
   * entries written then still parse; nothing writes it now.
   */
  'device.transferred',
  /**
   * Somebody signed in on a phone for the first time while other people already use it
   * (0025). Nobody loses access — the phone is shared — but who can use a handset is a
   * fact worth being able to find.
   */
  'device.user_added',
  'sync_conflict.resolved',
  /**
   * D11 (2026-10-05): a phone's upload, one entry per batch that changed or held something.
   * A replayed batch id and a batch where every item is still waiting write nothing, so an
   * HTTP retry or a photo still uploading never adds a row. `after` is `syncUploadLogSchema`.
   */
  'sync.batch_received',
  /** D11: one item of an upload was held for review (§9.5). `after` is `syncHeldLogSchema`. */
  'sync.item_held',
  /** The auditor withdrew an unfinished Zone from their audit ("abort this Zone", 0031). */
  'audit_zone.withdrawn',
  /** Kaizen (R-48): a Zone Leader filed one; the DRAFT got its number. */
  'kaizen.created',
  /** The author submitted it, first time or after a send-back. */
  'kaizen.submitted',
  /** The Coordinator's three answers; each also writes `kaizen_review`, in the same transaction. */
  'kaizen.approved',
  'kaizen.sent_back',
  'kaizen.rejected',
  /** The author discarded their draft (R-49). The row stays, marked `discarded_at`. */
  'kaizen.discarded',
] as const;
export const auditLogActionSchema = z.enum(AUDIT_LOG_ACTIONS);
export type AuditLogAction = z.infer<typeof auditLogActionSchema>;

export const auditLogEntrySchema = z.object({
  id: z.string(),
  actorUserId: uuidSchema.nullable(),
  actorRole: roleSchema.nullable(),
  /** Snapshotted label, so a later rename does not obscure history. */
  actorLabel: z.string(),
  action: auditLogActionSchema,
  resourceType: z.string(),
  resourceId: uuidSchema.nullable(),
  unitId: uuidSchema.nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  deviceId: uuidSchema.nullable(),
  requestId: z.string(),
  occurredAt: isoDateTimeSchema,
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const listAuditLogQuerySchema = paginationQuerySchema.extend({
  action: auditLogActionSchema.optional(),
  actorUserId: uuidSchema.optional(),
  /** One record kind, or several comma-separated ("About: Checklist" spans three tables). */
  resourceType: z
    .string()
    .trim()
    .max(200)
    .regex(/^[a-z_]+(,[a-z_]+)*$/)
    .optional(),
  resourceId: uuidSchema.optional(),
  unitId: uuidSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export type ListAuditLogQuery = z.infer<typeof listAuditLogQuerySchema>;
