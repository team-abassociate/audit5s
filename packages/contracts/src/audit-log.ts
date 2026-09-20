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
  'zone.created',
  'zone.updated',
  'zone.archived',
  'zone.leader_assigned',
  'checklist.imported',
  'checklist.published',
  'checklist.deactivated',
  'checklist.template_updated',
  'audit_assignment.created',
  'audit_assignment.cancelled',
  'audit.changed_after_completion',
  'audit.cancelled',
  /** §9.5 Layer 1's force-release: a Super Admin breaks a device's single-writer lock. */
  'audit.device_released',
  'report.generated',
  'report.token_revoked',
  'corrective_action.verified',
  'corrective_action.reopened',
  'corrective_action.reassigned',
  'evidence.redacted',
  'permission.changed',
  'unit.created',
  'unit.updated',
  'unit.archived',
  'device.revoked',
  /**
   * A handset changed hands: somebody signed in on a device registered to another user,
   * and login moved it to them. Recorded because it is the moment the previous owner's
   * unsynced work on that phone stops being reachable from it.
   */
  'device.transferred',
  'sync_conflict.resolved',
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
  resourceType: z.string().trim().max(60).optional(),
  resourceId: uuidSchema.optional(),
  unitId: uuidSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export type ListAuditLogQuery = z.infer<typeof listAuditLogQuerySchema>;
