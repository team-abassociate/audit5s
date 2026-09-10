import { describe, expect, it } from 'vitest';
import { ROLES } from '@audit5s/contracts';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_MATRIX,
  findPermission,
  grantFor,
  permissionsForRole,
} from './permission-matrix';

describe('matrix integrity', () => {
  it('has no duplicate resource:action pairs', () => {
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(ALL_PERMISSION_KEYS.length);
  });

  it('gives every permission at least one grant — an ungrantable permission is dead weight', () => {
    for (const definition of PERMISSION_MATRIX) {
      expect(Object.keys(definition.grants).length).toBeGreaterThan(0);
    }
  });

  it('describes every permission', () => {
    for (const definition of PERMISSION_MATRIX) {
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it('grants SUPER_ADMIN the organization resolver everywhere but its own inbox (AZ-4)', () => {
    // SUPER_ADMIN is not a bypass flag: it resolves to the predicate TRUE through the same
    // resolver machinery as every other role. The exception is the personal resources —
    // a Super Admin reads their *own* notifications, not everybody's, exactly as PART 6.3
    // has it.
    const personalResources = new Set(['notification', 'notification_preference']);
    for (const definition of PERMISSION_MATRIX) {
      const grant = definition.grants.SUPER_ADMIN;
      if (!grant) continue;
      if (personalResources.has(definition.resource)) {
        expect(grant.resolver).toBe('own_record');
      } else {
        expect(grant.resolver).toBe('organization');
      }
    }
  });

  it('never grants the organization resolver to a non-SUPER_ADMIN role', () => {
    const reference = new Set(['checklist_template:read', 'checklist_version:read']);
    for (const definition of PERMISSION_MATRIX) {
      for (const role of ROLES) {
        if (role === 'SUPER_ADMIN') continue;
        const grant = definition.grants[role];
        if (grant?.resolver === 'organization') {
          // The only exception is the organization-wide checklist catalogue (D2), which
          // carries no Unit-identifying information and must be cacheable offline.
          expect(reference.has(`${definition.resource}:${definition.action}`)).toBe(true);
        }
      }
    }
  });
});

describe('the cells ARCHITECTURE.md §6.4 and §15.2 call out by name', () => {
  it('denies a Coordinator any grant to rename their Unit (U-1)', () => {
    expect(grantFor('COORDINATOR', 'unit:update_identity')).toBeNull();
    // …while still allowing the profile fields.
    expect(grantFor('COORDINATOR', 'unit:update_profile')?.resolver).toBe('own_unit');
  });

  it('denies a Consultant the official report generation entirely (N5)', () => {
    expect(grantFor('CONSULTANT', 'report:generate')).toBeNull();
    expect(grantFor('SUPER_ADMIN', 'report:generate')?.resolver).toBe('organization');
  });

  it('allows a Zone Leader to cross-audit any Zone of their Unit, their own included (D9)', () => {
    const grant = grantFor('ZONE_LEADER', 'audit:create_cross');
    expect(grant?.resolver).toBe('own_unit');
    expect(grant?.condition).toMatch(/self-audit permitted/i);
  });

  it('gives nobody, ever, a delete on an audit (D8)', () => {
    expect(findPermission('audit:delete')).toBeUndefined();
    for (const role of ROLES) {
      expect(grantFor(role, 'audit:delete')).toBeNull();
    }
  });

  it('scopes a Coordinator to their own Unit and a Consultant to assigned Units', () => {
    expect(grantFor('COORDINATOR', 'zone:update')?.resolver).toBe('own_unit');
    expect(grantFor('CONSULTANT', 'zone:read')?.resolver).toBe('assigned_units');
    expect(grantFor('CONSULTANT', 'zone:update')).toBeNull();
  });

  it('lets only a Coordinator create users, and only ZONE_LEADERs', () => {
    const grant = grantFor('COORDINATOR', 'user:create');
    expect(grant?.resolver).toBe('own_unit');
    expect(grant?.condition).toMatch(/ZONE_LEADER/);
    expect(grantFor('CONSULTANT', 'user:create')).toBeNull();
    expect(grantFor('ZONE_LEADER', 'user:create')).toBeNull();
  });

  it('restricts the audit log to SUPER_ADMIN', () => {
    expect(grantFor('SUPER_ADMIN', 'audit_log:read')?.resolver).toBe('organization');
    for (const role of ['CONSULTANT', 'COORDINATOR', 'ZONE_LEADER'] as const) {
      expect(grantFor(role, 'audit_log:read')).toBeNull();
    }
  });

  it('keeps evidence redaction (R-5) a SUPER_ADMIN-only operation', () => {
    expect(grantFor('SUPER_ADMIN', 'evidence:redact')?.resolver).toBe('organization');
    for (const role of ['CONSULTANT', 'COORDINATOR', 'ZONE_LEADER'] as const) {
      expect(grantFor(role, 'evidence:redact')).toBeNull();
    }
  });

  it('keeps the deliberate assigned_actions widening on corrective-action submit (R-3b)', () => {
    const grant = grantFor('ZONE_LEADER', 'corrective_action:submit');
    expect(grant?.resolver).toBe('assigned_actions');
  });
});

describe('permissionsForRole', () => {
  it('gives SUPER_ADMIN the widest set and CONSULTANT a strictly narrower one', () => {
    const superAdmin = permissionsForRole('SUPER_ADMIN');
    const consultant = permissionsForRole('CONSULTANT');
    expect(superAdmin.length).toBeGreaterThan(consultant.length);
  });

  it('returns only keys that exist in the matrix', () => {
    for (const role of ROLES) {
      for (const key of permissionsForRole(role)) {
        expect(findPermission(key)).toBeDefined();
      }
    }
  });

  it('gives every role something — no role is locked out of the product', () => {
    for (const role of ROLES) {
      expect(permissionsForRole(role).length).toBeGreaterThan(0);
    }
  });
});
