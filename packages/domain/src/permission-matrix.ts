import type { Resource, Role, ScopeResolverName, PermissionKey } from '@audit5s/contracts';

/**
 * The authorization matrix of ARCHITECTURE.md §6.3, as data.
 *
 * This is the single definition. `apps/api`'s seed writes `permission` and `role_permission`
 * from it, `PermissionGuard` reads it, and the authorization-matrix test suite asserts that
 * the seeded rows and this table agree — so the document, the seed and the runtime cannot
 * drift (§12.4).
 *
 * Two rules that this shape encodes deliberately:
 *
 *   - **Role alone never authorizes anything.** A grant is a role *plus* a scope resolver;
 *     there is no way to express "this role may do this" without naming the scope.
 *   - **`SUPER_ADMIN` is not a bypass flag** (AZ-4). It appears as the `organization`
 *     resolver, which resolves to the predicate `TRUE` through the same code path as every
 *     other resolver, so every query is still built the same way.
 *
 * An action absent from a role's grants is denied. `Audit.delete` appears nowhere, for
 * anyone, by design (D8).
 */

export interface ScopeGrant {
  resolver: ScopeResolverName;
  /**
   * An additional constraint the matrix cell states in prose, enforced in the service
   * layer. Present so the constraint is visible next to the grant rather than only in the
   * handler that implements it.
   */
  condition?: string;
}

export interface PermissionDefinition {
  resource: Resource;
  action: string;
  description: string;
  grants: Partial<Record<Role, ScopeGrant>>;
}

const org: ScopeGrant = { resolver: 'organization' };
const ownUnit: ScopeGrant = { resolver: 'own_unit' };
const ownRecord: ScopeGrant = { resolver: 'own_record' };
const assignedUnits: ScopeGrant = { resolver: 'assigned_units' };
const ownAudits: ScopeGrant = { resolver: 'own_audits' };

/** Every role, for the read-only reference data that all four may see. */
const allRoles = (grant: ScopeGrant): Partial<Record<Role, ScopeGrant>> => ({
  SUPER_ADMIN: grant,
  CONSULTANT: grant,
  COORDINATOR: grant,
  ZONE_LEADER: grant,
});

export const PERMISSION_MATRIX: readonly PermissionDefinition[] = [
  // ---------------------------------------------------------------- Identity & access
  {
    resource: 'user',
    action: 'create',
    description: 'Create a user account and allocate its login ID',
    grants: {
      SUPER_ADMIN: org,
      COORDINATOR: { resolver: 'own_unit', condition: 'target role must be ZONE_LEADER' },
    },
  },
  {
    resource: 'user',
    action: 'read',
    description: 'Read user records',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: ownRecord,
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownRecord,
    },
  },
  {
    resource: 'user',
    action: 'update',
    description: 'Update a user record',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: { resolver: 'own_record', condition: 'profile fields only' },
      COORDINATOR: { resolver: 'own_unit', condition: 'target role must be ZONE_LEADER' },
      ZONE_LEADER: { resolver: 'own_record', condition: 'profile fields only' },
    },
  },
  {
    resource: 'user',
    action: 'disable',
    description: 'Disable a user, revoking sessions and devices',
    grants: {
      SUPER_ADMIN: org,
      COORDINATOR: { resolver: 'own_unit', condition: 'target role must be ZONE_LEADER' },
    },
  },
  {
    resource: 'user',
    action: 'reset_password',
    description: 'Issue a fresh bootstrap credential and force a reset',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: ownRecord,
      COORDINATOR: { resolver: 'own_unit', condition: 'target role must be ZONE_LEADER' },
      ZONE_LEADER: ownRecord,
    },
  },
  {
    resource: 'role_permission',
    action: 'read',
    description: 'Read the role/permission matrix',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'role_permission',
    action: 'update',
    description: 'Change the role/permission matrix',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'device',
    action: 'list',
    description: 'List registered devices',
    grants: { SUPER_ADMIN: org, CONSULTANT: ownRecord, ZONE_LEADER: ownRecord },
  },
  {
    resource: 'device',
    action: 'revoke',
    description: 'Revoke a device',
    grants: { SUPER_ADMIN: org, CONSULTANT: ownRecord, ZONE_LEADER: ownRecord },
  },

  // ------------------------------------------------------------- Units & memberships
  {
    resource: 'unit',
    action: 'create',
    description: 'Create a Unit',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'unit',
    action: 'read',
    description: 'Read Unit master data',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: assignedUnits,
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownUnit,
    },
  },
  {
    // Invariant U-1. Deliberately a separate permission from `update_profile` so that the
    // Coordinator's denial is a missing grant, not a runtime field check alone.
    resource: 'unit',
    action: 'update_identity',
    description: 'Change Unit name or code (U-1)',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'unit',
    action: 'update_profile',
    description: 'Change Unit address, contact, geofence or timezone',
    grants: { SUPER_ADMIN: org, COORDINATOR: ownUnit },
  },
  {
    resource: 'unit',
    action: 'archive',
    description: 'Archive a Unit',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'unit_membership',
    action: 'create',
    description: 'Assign a user to a Unit',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'unit_membership',
    action: 'revoke',
    description: 'Revoke a Unit assignment',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'unit_membership',
    action: 'read',
    description: 'Read Unit assignments',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: ownRecord,
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownUnit,
    },
  },

  // ------------------------------------------------------------------------- Zones
  {
    resource: 'zone',
    action: 'create',
    description: 'Create a Zone',
    grants: { SUPER_ADMIN: org, COORDINATOR: ownUnit },
  },
  {
    resource: 'zone',
    action: 'read',
    description: 'Read Zones',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: assignedUnits,
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownUnit,
    },
  },
  {
    resource: 'zone',
    action: 'update',
    description: 'Update a Zone',
    grants: { SUPER_ADMIN: org, COORDINATOR: ownUnit },
  },
  {
    resource: 'zone',
    action: 'archive',
    description: 'Archive a Zone',
    grants: { SUPER_ADMIN: org, COORDINATOR: ownUnit },
  },
  {
    resource: 'zone',
    action: 'assign_leader',
    description: 'Point a Zone at its Zone Leader (a responsibility pointer, not a grant)',
    grants: { SUPER_ADMIN: org, COORDINATOR: ownUnit },
  },

  // --------------------------------------------------------------------- Checklists
  // Organization-wide reference data (D2): read access is intentionally broad, because it
  // carries no Unit-identifying information and every field client must cache it offline.
  {
    resource: 'checklist_template',
    action: 'create',
    description: 'Create a checklist template',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'checklist_template',
    action: 'update',
    description: 'Update a checklist template',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'checklist_template',
    action: 'archive',
    description: 'Archive a checklist template',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'checklist_template',
    action: 'read',
    description: 'Read the checklist catalogue',
    grants: allRoles(org),
  },
  {
    resource: 'checklist_version',
    action: 'read',
    description: 'Read a published checklist version and its questions',
    grants: allRoles(org),
  },
  {
    resource: 'checklist_version',
    action: 'publish',
    description: 'Publish a draft checklist version',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'checklist_version',
    action: 'deactivate',
    description: 'Archive a published checklist version',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'checklist_import',
    action: 'upload',
    description: 'Upload a checklist workbook',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'checklist_import',
    action: 'preview',
    description: 'Validate and preview an import job',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'checklist_import',
    action: 'commit',
    description: 'Commit an import job into a draft version',
    grants: { SUPER_ADMIN: org },
  },

  // --------------------------------------------------------- Assignments and audits
  {
    resource: 'audit_assignment',
    action: 'create',
    description: 'Assign an audit to a Consultant',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'audit_assignment',
    action: 'read',
    description: 'Read audit assignments',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: { resolver: 'own_record', condition: 'assignee only' },
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownUnit,
    },
  },
  {
    resource: 'audit_assignment',
    action: 'cancel',
    description: 'Cancel an audit assignment',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'audit',
    action: 'create_external',
    description: 'Start an EXTERNAL_5S audit',
    grants: {
      CONSULTANT: { resolver: 'assigned_units', condition: 'an active assignment must exist' },
    },
  },
  {
    resource: 'audit',
    action: 'create_walk_by',
    description: 'Start a WALK_BY audit',
    grants: { CONSULTANT: assignedUnits },
  },
  {
    resource: 'audit',
    action: 'create_cross',
    description: 'Start a CROSS_5S audit',
    grants: {
      // N4 + D9: any active Zone of the Unit, including one the leader owns. Not a bug.
      ZONE_LEADER: { resolver: 'own_unit', condition: 'any active Zone; self-audit permitted (D9)' },
    },
  },
  {
    resource: 'audit',
    action: 'read',
    description: 'Read audits',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: ownAudits,
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownUnit,
    },
  },
  {
    resource: 'audit',
    action: 'update',
    description: 'Update an in-progress audit',
    grants: {
      CONSULTANT: { resolver: 'own_audits', condition: 'owning_device_id must match the caller' },
      ZONE_LEADER: { resolver: 'own_audits', condition: 'owning_device_id must match the caller' },
    },
  },
  {
    resource: 'audit',
    action: 'pause',
    description: 'Pause (abort) an audit',
    grants: { SUPER_ADMIN: org, CONSULTANT: ownAudits, ZONE_LEADER: ownAudits },
  },
  {
    resource: 'audit',
    action: 'resume',
    description: 'Resume a paused audit',
    grants: { CONSULTANT: ownAudits, ZONE_LEADER: ownAudits },
  },
  {
    resource: 'audit',
    action: 'complete',
    description: 'Complete an audit',
    grants: { CONSULTANT: ownAudits, ZONE_LEADER: ownAudits },
  },
  {
    resource: 'audit',
    action: 'cancel',
    description: 'Cancel an audit',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'audit',
    action: 'edit_after_completion',
    description: 'Override a completed audit; always written to the audit log',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'audit_zone',
    action: 'create',
    description: 'Add a Zone to an audit, snapshotting its identity',
    grants: {
      CONSULTANT: { resolver: 'own_audits', condition: 'device owner' },
      ZONE_LEADER: { resolver: 'own_audits', condition: 'device owner' },
    },
  },
  {
    resource: 'audit_zone',
    action: 'update',
    description: 'Update an audit Zone',
    grants: {
      CONSULTANT: { resolver: 'own_audits', condition: 'device owner' },
      ZONE_LEADER: { resolver: 'own_audits', condition: 'device owner' },
    },
  },
  {
    resource: 'audit_zone',
    action: 'complete',
    description: 'Complete an audit Zone',
    grants: {
      CONSULTANT: { resolver: 'own_audits', condition: 'device owner' },
      ZONE_LEADER: { resolver: 'own_audits', condition: 'device owner' },
    },
  },
  {
    resource: 'audit_zone',
    action: 'read',
    description: 'Read audit Zones',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: ownAudits,
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownUnit,
    },
  },
  {
    resource: 'question_response',
    action: 'upsert',
    description: 'Record an answer',
    grants: {
      CONSULTANT: {
        resolver: 'own_audits',
        condition: 'device owner; audit must not be COMPLETED',
      },
      ZONE_LEADER: {
        resolver: 'own_audits',
        condition: 'device owner; audit must not be COMPLETED',
      },
    },
  },
  {
    resource: 'question_response',
    action: 'read',
    description: 'Read answers',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: ownAudits,
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownUnit,
    },
  },

  // ----------------------------------------------------------------------- Evidence
  {
    resource: 'evidence',
    action: 'create',
    description: 'Create an upload intent',
    grants: {
      CONSULTANT: ownAudits,
      ZONE_LEADER: {
        resolver: 'own_audits',
        condition: 'or assigned_actions, for CORRECTIVE_AFTER evidence',
      },
    },
  },
  {
    resource: 'evidence',
    action: 'read',
    description: 'Read evidence metadata',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: ownAudits,
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownUnit,
    },
  },
  {
    resource: 'evidence',
    action: 'view_url',
    description: 'Mint a short-TTL presigned GET for an evidence object',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: ownAudits,
      COORDINATOR: ownUnit,
      ZONE_LEADER: { resolver: 'own_unit', condition: 'or signed_token for the linked item' },
    },
  },
  {
    resource: 'evidence',
    action: 'soft_delete',
    description: 'Remove evidence before completion (E-4)',
    grants: {
      CONSULTANT: { resolver: 'own_audits', condition: 'audit must not be COMPLETED' },
      ZONE_LEADER: { resolver: 'own_audits', condition: 'audit must not be COMPLETED' },
    },
  },
  {
    resource: 'evidence',
    action: 'set_summary_flag',
    description: 'Flag a photo for the report summary',
    grants: { CONSULTANT: ownAudits, ZONE_LEADER: ownAudits },
  },
  {
    // DECISIONS.md R-5. Erasure is redaction, never deletion: the object is overwritten,
    // the row and its checksum survive, and the record says a photo was present.
    resource: 'evidence',
    action: 'redact',
    description: 'Redact an evidence photo, overwriting the object and keeping the record',
    grants: { SUPER_ADMIN: org },
  },

  // -------------------------------------------------------------- Corrective actions
  {
    resource: 'corrective_action',
    action: 'read',
    description: 'Read corrective actions',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: { resolver: 'own_audits', condition: 'items raised by their audit' },
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownUnit,
    },
  },
  {
    resource: 'corrective_action',
    action: 'submit',
    description: 'Submit option A (completed) or B (not possible)',
    grants: {
      // R-3b: `assigned_actions` widens deliberately to any Zone Leader of the Unit, so a
      // corrective action does not stall while its assignee is on leave. Do not narrow.
      ZONE_LEADER: { resolver: 'assigned_actions', condition: 'or via a valid signed token' },
    },
  },
  {
    resource: 'corrective_action',
    action: 'verify',
    description: 'Verify a submitted corrective action',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'corrective_action',
    action: 'reopen',
    description: 'Reopen a corrective action',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'corrective_action',
    action: 'reassign',
    description: 'Reassign a corrective action to another Zone Leader',
    grants: { SUPER_ADMIN: org, COORDINATOR: ownUnit },
  },
  {
    resource: 'corrective_action_submission',
    action: 'read',
    description: 'Read corrective-action submissions',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: ownAudits,
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownUnit,
    },
  },

  // ---------------------------------------------------------------------- Reporting
  {
    // N5/N6: the official PDF is a Super Admin deliverable. A Consultant posting here gets
    // 403 because the permission is absent for the role entirely, not because of scope.
    resource: 'report',
    action: 'generate',
    description: 'Generate an official PDF report',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'report',
    action: 'read_snapshot',
    description: 'Read report snapshot metadata',
    grants: { SUPER_ADMIN: org, COORDINATOR: ownUnit, ZONE_LEADER: ownUnit },
  },
  {
    resource: 'report',
    action: 'download',
    description: 'Download a report PDF',
    grants: { SUPER_ADMIN: org, COORDINATOR: ownUnit, ZONE_LEADER: ownUnit },
  },
  {
    resource: 'report',
    action: 'score_summary',
    description: 'Read a non-official score summary',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: ownAudits,
      COORDINATOR: ownUnit,
      ZONE_LEADER: ownUnit,
    },
  },
  {
    resource: 'report_access_token',
    action: 'mint',
    description: 'Mint a signed report/corrective-action link',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'report_access_token',
    action: 'revoke',
    description: 'Revoke a signed link',
    grants: { SUPER_ADMIN: org },
  },

  // --------------------------------------- Analytics, notifications, logs, sync
  {
    resource: 'analytics',
    action: 'organization_dashboard',
    description: 'Organization-wide analytics',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'analytics',
    action: 'unit_dashboard',
    description: 'Unit and Zone analytics',
    grants: { SUPER_ADMIN: org, COORDINATOR: ownUnit },
  },
  {
    resource: 'analytics',
    action: 'own_activity',
    description: 'A user’s own activity',
    grants: {
      SUPER_ADMIN: org,
      CONSULTANT: ownRecord,
      COORDINATOR: ownRecord,
      ZONE_LEADER: ownRecord,
    },
  },
  {
    resource: 'notification',
    action: 'read',
    description: 'Read own notifications',
    grants: allRoles(ownRecord),
  },
  {
    resource: 'notification',
    action: 'mark_read',
    description: 'Mark own notifications read',
    grants: allRoles(ownRecord),
  },
  {
    resource: 'notification_preference',
    action: 'update',
    description: 'Update own notification preferences',
    grants: allRoles(ownRecord),
  },
  {
    resource: 'audit_log',
    action: 'read',
    description: 'Read the audit log',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'sync_conflict',
    action: 'read',
    description: 'Read quarantined sync conflicts',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'sync_conflict',
    action: 'resolve',
    description: 'Resolve a quarantined sync conflict',
    grants: { SUPER_ADMIN: org },
  },
  {
    resource: 'sync',
    action: 'push',
    description: 'Push a sync batch',
    grants: {
      CONSULTANT: { resolver: 'own_audits', condition: 'intersected with assigned_units' },
      ZONE_LEADER: { resolver: 'own_audits', condition: 'intersected with own_unit' },
    },
  },
  {
    resource: 'sync',
    action: 'pull',
    description: 'Pull a sync batch',
    grants: {
      CONSULTANT: { resolver: 'own_audits', condition: 'intersected with assigned_units' },
      ZONE_LEADER: { resolver: 'own_audits', condition: 'intersected with own_unit' },
    },
  },
] as const;

/** `resource:action` for every permission in the matrix. */
export function permissionKeyOf(definition: PermissionDefinition): PermissionKey {
  return `${definition.resource}:${definition.action}` as PermissionKey;
}

const BY_KEY = new Map<string, PermissionDefinition>(
  PERMISSION_MATRIX.map((definition) => [permissionKeyOf(definition), definition]),
);

export function findPermission(key: string): PermissionDefinition | undefined {
  return BY_KEY.get(key);
}

/** The scope resolver a role holds for a permission, or `null` when it holds none. */
export function grantFor(role: Role, key: string): ScopeGrant | null {
  return BY_KEY.get(key)?.grants[role] ?? null;
}

/** Every permission key a role holds. Drives the `scope.permissions` list on `/auth/me`. */
export function permissionsForRole(role: Role): PermissionKey[] {
  return PERMISSION_MATRIX.filter((definition) => definition.grants[role] !== undefined).map(
    permissionKeyOf,
  );
}

export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_MATRIX.map(permissionKeyOf);
