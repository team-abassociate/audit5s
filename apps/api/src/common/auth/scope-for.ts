import { grantFor, type ScopeContext } from '@audit5s/domain';

/**
 * The scope for **another** resource than the one that admitted the request.
 *
 * A handler often has to read a second table on the way: an audit-Zone upsert reads the
 * live `zone` to take its D6 snapshot, and the sync catalogue reads four tables at once.
 * Reusing the resolver that let the caller in would be a quiet widening in one direction
 * and a crash in the other — `own_audits` asks for an `ownerUserId` column that `zone`
 * does not have.
 *
 * So the scope is re-derived from PART 6 for the resource actually being read. A role with
 * no grant for it gets an actor with no Units, which every resolver turns into "nothing":
 * an absent cell in the matrix means denied, and that is what it means here too.
 */
export function scopeFor(scope: ScopeContext, permissionKey: string): ScopeContext {
  const grant = grantFor(scope.actor.role, permissionKey);
  if (!grant) {
    return {
      actor: { ...scope.actor, unitIds: [], activeUnitId: null },
      resolver: 'own_unit',
    };
  }
  return {
    actor: scope.actor,
    resolver: grant.resolver,
    ...(grant.condition ? { condition: grant.condition } : {}),
  };
}
