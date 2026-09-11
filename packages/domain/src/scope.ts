import type { Role, ScopeResolverName } from '@audit5s/contracts';

/**
 * The actor, as resolved from the database on every request.
 *
 * Scope is **never** read from the access token (ARCHITECTURE.md §12.3): the token carries
 * `sub`, `role`, `jti` and `deviceId` and nothing else, so revoking a Unit assignment takes
 * effect immediately rather than at token expiry.
 */
export interface ActorContext {
  userId: string;
  role: Role;
  /**
   * The single active Unit of a COORDINATOR or ZONE_LEADER, which invariant M-1 guarantees
   * is unique (DECISIONS.md R-3a enforces it with a partial unique index, so `own_unit`'s
   * `LIMIT 1` is deterministic). `null` for a SUPER_ADMIN, and for a CONSULTANT, who may
   * hold many.
   */
  activeUnitId: string | null;
  /** Every Unit the actor currently has an ACTIVE membership in. */
  unitIds: string[];
  /** From `X-Device-Id`. Required on mobile writes; `null` for web sessions. */
  deviceId: string | null;
}

/**
 * What a repository is handed. AZ-1: no repository method may execute without one — the
 * base repository takes it as an explicit argument, and a lint rule forbids constructing a
 * Drizzle query outside a repository class.
 */
export interface ScopeContext {
  actor: ActorContext;
  resolver: ScopeResolverName;
  /** The prose constraint from the matrix cell, for the service layer to enforce (AZ-5). */
  condition?: string;
}

/**
 * Out-of-scope **reads** return 404 rather than 403, so object IDs cannot be probed for
 * existence (AZ-3, §12.4). Out-of-scope **writes** on a resource the actor can already read
 * return 403. Both clients rely on this distinction, so it is stated once here.
 */
export type OutOfScopeOutcome = 'NOT_FOUND' | 'FORBIDDEN';

export function outOfScopeOutcome(intent: 'read' | 'write'): OutOfScopeOutcome {
  return intent === 'read' ? 'NOT_FOUND' : 'FORBIDDEN';
}
