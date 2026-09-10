import { z } from 'zod';

/**
 * Permission vocabulary. The matrix itself (which role holds which permission, under which
 * scope resolver) is pure data and lives in `@audit5s/domain`; only the tokens that cross an
 * app boundary are defined here.
 */

/** The scope resolvers of ARCHITECTURE.md §6.2. Each names a SQL predicate, not a boolean. */
export const SCOPE_RESOLVERS = [
  'organization',
  'own_unit',
  'assigned_units',
  'own_audits',
  'own_record',
  'assigned_actions',
  'signed_token',
] as const;
export const scopeResolverSchema = z.enum(SCOPE_RESOLVERS);
export type ScopeResolverName = z.infer<typeof scopeResolverSchema>;

export const RESOURCES = [
  'user',
  'role_permission',
  'device',
  'unit',
  'unit_membership',
  'zone',
  'checklist_template',
  'checklist_version',
  'checklist_import',
  'audit_assignment',
  'audit',
  'audit_zone',
  'question_response',
  'evidence',
  'corrective_action',
  'corrective_action_submission',
  'report',
  'report_access_token',
  'analytics',
  'notification',
  'notification_preference',
  'audit_log',
  'sync_conflict',
  'sync',
] as const;
export const resourceSchema = z.enum(RESOURCES);
export type Resource = z.infer<typeof resourceSchema>;

/**
 * `resource:action`. Actions are per-resource; the pairing is validated by the matrix in
 * `@audit5s/domain`, which is the only place a permission may be introduced.
 */
export const permissionKeySchema = z
  .string()
  .regex(/^[a-z_]+:[a-z_]+$/, 'Permission key must be `resource:action`');
export type PermissionKey = `${Resource}:${string}`;

export function permissionKey(resource: Resource, action: string): PermissionKey {
  return `${resource}:${action}` as PermissionKey;
}

export const permissionSchema = z.object({
  id: z.uuid(),
  resource: resourceSchema,
  action: z.string(),
  description: z.string(),
});
export type Permission = z.infer<typeof permissionSchema>;
