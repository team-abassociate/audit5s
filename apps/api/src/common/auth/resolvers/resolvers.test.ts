import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { units, unitMemberships } from '@audit5s/db';
import type { ActorContext } from '@audit5s/domain';
import {
  AssignedActionsScopeResolver,
  AssignedUnitsScopeResolver,
  OrganizationScopeResolver,
  OwnAuditsScopeResolver,
  OwnRecordScopeResolver,
  OwnUnitScopeResolver,
  ScopeResolverRegistry,
} from './index';

/**
 * Scope resolvers, unit-tested in isolation (STACK.md §5).
 *
 * These assert the *shape* of the predicate — that it binds the actor's own values and,
 * crucially, that an actor with nothing in scope produces a predicate matching nothing
 * rather than one matching everything. The end-to-end behaviour is covered by the
 * authorization suite against a real database.
 */

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: 'user-1',
    role: 'COORDINATOR',
    activeUnitId: 'unit-a',
    unitIds: ['unit-a'],
    deviceId: null,
    ...overrides,
  };
}

const dialect = new PgDialect();

/**
 * Compiles a predicate to its real SQL text and bound parameters — the same way Drizzle
 * will when the repository runs it, so these assertions describe what actually reaches
 * PostgreSQL rather than an internal representation.
 */
function render(predicate: ReturnType<OwnUnitScopeResolver['predicate']>): string {
  const query = dialect.sqlToQuery(predicate);
  return `${query.sql} -- params: ${JSON.stringify(query.params)}`;
}

describe('organization', () => {
  it('is the predicate TRUE, reached through the same code path as any other (AZ-4)', () => {
    const resolver = new OrganizationScopeResolver();
    expect(render(resolver.predicate())).toContain('true');
  });
});

describe('own_unit', () => {
  it('binds the actor’s single active Unit', () => {
    const resolver = new OwnUnitScopeResolver();
    const predicate = resolver.predicate(actor(), { unitId: units.id });
    expect(render(predicate)).toContain('unit-a');
  });

  it('matches nothing when the actor has no active Unit', () => {
    // A Coordinator whose membership was revoked has no scope, and must therefore see
    // nothing — not everything, which is what an empty predicate would mean.
    const resolver = new OwnUnitScopeResolver();
    const predicate = resolver.predicate(actor({ activeUnitId: null, unitIds: [] }), {
      unitId: units.id,
    });
    expect(render(predicate)).toContain('false');
  });

  it('refuses to run against a table that has no unit column', () => {
    const resolver = new OwnUnitScopeResolver();
    expect(() => resolver.predicate(actor(), {})).toThrow(/needs the 'unitId' column/);
  });
});

describe('assigned_units', () => {
  it('binds every Unit the Consultant currently holds', () => {
    const resolver = new AssignedUnitsScopeResolver();
    const predicate = resolver.predicate(
      actor({ role: 'CONSULTANT', activeUnitId: null, unitIds: ['unit-a', 'unit-b'] }),
      { unitId: units.id },
    );
    const rendered = render(predicate);
    expect(rendered).toContain('unit-a');
    expect(rendered).toContain('unit-b');
  });

  it('matches nothing for a Consultant with no assignments', () => {
    const resolver = new AssignedUnitsScopeResolver();
    const predicate = resolver.predicate(
      actor({ role: 'CONSULTANT', activeUnitId: null, unitIds: [] }),
      { unitId: units.id },
    );
    expect(render(predicate)).toContain('false');
  });
});

describe('own_record and own_audits', () => {
  it('own_record binds the actor’s own id', () => {
    const resolver = new OwnRecordScopeResolver();
    const predicate = resolver.predicate(actor(), { recordUserId: unitMemberships.userId });
    expect(render(predicate)).toContain('user-1');
  });

  it('own_audits binds the actor as the audit owner', () => {
    const resolver = new OwnAuditsScopeResolver();
    const predicate = resolver.predicate(actor(), { ownerUserId: unitMemberships.userId });
    expect(render(predicate)).toContain('user-1');
  });
});

describe('assigned_actions (R-3b)', () => {
  it('matches the assignee OR the Unit — the widening is deliberate', () => {
    // Assigned leaders take leave, and corrective actions must not stall. Narrowing this
    // is a product decision, not a tidy-up.
    const resolver = new AssignedActionsScopeResolver();
    const predicate = resolver.predicate(actor({ role: 'ZONE_LEADER' }), {
      assignedUserId: unitMemberships.userId,
      unitId: unitMemberships.unitId,
    });
    const rendered = render(predicate);
    expect(rendered).toContain('user-1');
    expect(rendered).toContain('unit-a');
    expect(rendered).toContain('OR');
  });

  it('falls back to the assignee alone when the leader has no active Unit', () => {
    const resolver = new AssignedActionsScopeResolver();
    const predicate = resolver.predicate(
      actor({ role: 'ZONE_LEADER', activeUnitId: null, unitIds: [] }),
      { assignedUserId: unitMemberships.userId, unitId: unitMemberships.unitId },
    );
    expect(render(predicate)).toContain('user-1');
  });
});

describe('registry', () => {
  const registry = new ScopeResolverRegistry(
    new OrganizationScopeResolver(),
    new OwnUnitScopeResolver(),
    new AssignedUnitsScopeResolver(),
    new OwnRecordScopeResolver(),
    new OwnAuditsScopeResolver(),
    new AssignedActionsScopeResolver(),
  );

  it('resolves every name PART 6.2 uses in Phase 1', () => {
    for (const name of ['organization', 'own_unit', 'assigned_units', 'own_record', 'own_audits', 'assigned_actions'] as const) {
      expect(registry.get(name).name).toBe(name);
    }
  });

  it('throws for a resolver that does not exist yet, rather than defaulting', () => {
    // `signed_token` arrives with the public corrective-action route in Phase 7. A
    // permissive default here would be a silent authorization hole.
    expect(() => registry.get('signed_token')).toThrow(/No scope resolver registered/);
    expect(registry.has('signed_token')).toBe(false);
  });
});
