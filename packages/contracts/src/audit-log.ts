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
  'user.password_reset',
  'consultant.assigned',
  'consultant.revoked',
  'coordinator.assigned',
  'coordinator.revoked',
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
  'report.generated',
  'report.token_revoked',
  'corrective_action.verified',
  'corrective_action.reopened',
  'evidence.redacted',
  'permission.changed',
  'unit.created',
  'unit.updated',
  'unit.archived',
  'device.revoked',
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
