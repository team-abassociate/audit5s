import { Injectable } from '@nestjs/common';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { ScopeResolverName } from '@audit5s/contracts';
import type { ActorContext } from '@audit5s/domain';
import {
  MATCH_NOTHING,
  requireColumn,
  type ScopeColumns,
  type ScopeResolver,
} from './scope-resolver';

/**
 * `organization` — the predicate `TRUE`.
 *
 * AZ-4: SUPER_ADMIN is not a bypass flag. It goes through this resolver like every other
 * role, so the query is still built the same way and there is no branch anywhere that
 * skips predicate construction.
 */
@Injectable()
export class OrganizationScopeResolver implements ScopeResolver {
  readonly name: ScopeResolverName = 'organization';

  predicate(): SQL {
    return sql`true`;
  }
}

/**
 * `own_unit` — the single Unit of a COORDINATOR or ZONE_LEADER.
 *
 * Deterministic because invariant M-1 permits those roles at most one ACTIVE membership,
 * enforced by the partial unique index that ships in the first migration (R-3a). Without
 * that index this resolver would silently pick one of several Units.
 */
@Injectable()
export class OwnUnitScopeResolver implements ScopeResolver {
  readonly name: ScopeResolverName = 'own_unit';

  predicate(actor: ActorContext, columns: ScopeColumns): SQL {
    const unitId = requireColumn(columns, 'unitId', this.name);
    if (!actor.activeUnitId) {
      // A Coordinator with no active membership has no scope, and therefore sees nothing.
      return MATCH_NOTHING;
    }
    return eq(unitId, actor.activeUnitId);
  }
}

/** `assigned_units` — every Unit a CONSULTANT currently holds an ACTIVE membership in. */
@Injectable()
export class AssignedUnitsScopeResolver implements ScopeResolver {
  readonly name: ScopeResolverName = 'assigned_units';

  predicate(actor: ActorContext, columns: ScopeColumns): SQL {
    const unitId = requireColumn(columns, 'unitId', this.name);
    if (actor.unitIds.length === 0) {
      return MATCH_NOTHING;
    }
    return inArray(unitId, actor.unitIds);
  }
}

/** `own_record` — the actor's own row. */
@Injectable()
export class OwnRecordScopeResolver implements ScopeResolver {
  readonly name: ScopeResolverName = 'own_record';

  predicate(actor: ActorContext, columns: ScopeColumns): SQL {
    const recordUserId = requireColumn(columns, 'recordUserId', this.name);
    return eq(recordUserId, actor.userId);
  }
}

/** `own_audits` — audits this actor conducted. */
@Injectable()
export class OwnAuditsScopeResolver implements ScopeResolver {
  readonly name: ScopeResolverName = 'own_audits';

  predicate(actor: ActorContext, columns: ScopeColumns): SQL {
    const ownerUserId = requireColumn(columns, 'ownerUserId', this.name);
    return eq(ownerUserId, actor.userId);
  }
}

/**
 * `assigned_actions` — corrective actions assigned to this Zone Leader **or** belonging to
 * their Unit.
 *
 * The `OR` is deliberate (DECISIONS.md R-3b): assigned leaders take leave, and corrective
 * actions must not stall. Narrowing it is a product decision that needs a replacement for
 * the stall case, not a tidy-up.
 */
@Injectable()
export class AssignedActionsScopeResolver implements ScopeResolver {
  readonly name: ScopeResolverName = 'assigned_actions';

  predicate(actor: ActorContext, columns: ScopeColumns): SQL {
    const assignedUserId = requireColumn(columns, 'assignedUserId', this.name);
    const unitId = requireColumn(columns, 'unitId', this.name);
    if (!actor.activeUnitId) {
      return eq(assignedUserId, actor.userId);
    }
    return sql`(${eq(assignedUserId, actor.userId)} OR ${eq(unitId, actor.activeUnitId)})`;
  }
}

export const SCOPE_RESOLVERS = [
  OrganizationScopeResolver,
  OwnUnitScopeResolver,
  AssignedUnitsScopeResolver,
  OwnRecordScopeResolver,
  OwnAuditsScopeResolver,
  AssignedActionsScopeResolver,
] as const;

export const SCOPE_RESOLVER_REGISTRY = Symbol('SCOPE_RESOLVER_REGISTRY');

/** Name → resolver. Built by DI so resolvers stay unit-testable against fakes. */
@Injectable()
export class ScopeResolverRegistry {
  private readonly byName = new Map<ScopeResolverName, ScopeResolver>();

  constructor(
    organization: OrganizationScopeResolver,
    ownUnit: OwnUnitScopeResolver,
    assignedUnits: AssignedUnitsScopeResolver,
    ownRecord: OwnRecordScopeResolver,
    ownAudits: OwnAuditsScopeResolver,
    assignedActions: AssignedActionsScopeResolver,
  ) {
    for (const resolver of [
      organization,
      ownUnit,
      assignedUnits,
      ownRecord,
      ownAudits,
      assignedActions,
    ]) {
      this.byName.set(resolver.name, resolver);
    }
  }

  get(name: ScopeResolverName): ScopeResolver {
    const resolver = this.byName.get(name);
    if (!resolver) {
      // `signed_token` arrives with the public corrective-action route in Phase 7. Failing
      // loudly beats returning a permissive default for a resolver that does not yet exist.
      throw new Error(`No scope resolver registered for '${name}'`);
    }
    return resolver;
  }

  has(name: ScopeResolverName): boolean {
    return this.byName.has(name);
  }
}

export * from './scope-resolver';
