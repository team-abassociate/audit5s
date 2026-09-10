import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Resource, ScopeResolverName } from '@audit5s/contracts';
import type { ActorContext } from '@audit5s/domain';
import { getRequestContext } from '../observability/request-context';

export const PUBLIC_KEY = 'audit5s:public';
export const PERMISSION_KEY = 'audit5s:permission';
export const SCOPE_KEY = 'audit5s:scope';
export const ALLOW_PENDING_RESET_KEY = 'audit5s:allow-pending-reset';

/**
 * Opts a route out of the guard chain entirely. The guards are global (STACK.md §5), so
 * this is the only way out and it is deliberately conspicuous: every use needs a reason in
 * the PR. Only `/auth/*` and `/health` carry it.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export interface PermissionRequirement {
  resource: Resource;
  action: string;
}

/**
 * A route whose PART 6 cell depends on a discriminator in the request.
 *
 * There is exactly one of these: `POST /audits`, because §8.6 gives audit creation one
 * endpoint with an `auditType` in the body while PART 6 gives it three cells —
 * `create_external`, `create_walk_by` and `create_cross` — whose resolvers differ by role.
 * A static decorator would have to pick one, which for a Zone Leader starting a cross
 * audit means a 403 from a cell that was never meant to judge them.
 *
 * Nothing is widened by this. The guards run unchanged: `select` only chooses *which*
 * cell of the same matrix is consulted, and an actor naming a type they hold no grant for
 * is refused by `PermissionGuard` exactly as before. `candidates` lists every cell the
 * route can reach so a reader — and the authorization suite — can see them without
 * running the selector.
 */
export interface DynamicPermissionRequirement {
  candidates: readonly PermissionRequirement[];
  select: (body: unknown) => PermissionRequirement;
}

export type PermissionMetadata = PermissionRequirement | DynamicPermissionRequirement;

/** Check 2 of §6.1: does the role hold this permission at all? */
export const RequirePermission = (resource: Resource, action: string) =>
  SetMetadata(PERMISSION_KEY, { resource, action } satisfies PermissionRequirement);

/** The dynamic form. See `DynamicPermissionRequirement` for why it exists. */
export const RequirePermissionFor = (requirement: DynamicPermissionRequirement) =>
  SetMetadata(PERMISSION_KEY, requirement);

/** Resolves either form against a request body. Both guards go through this one path. */
export function resolvePermission(
  metadata: PermissionMetadata | undefined,
  body: unknown,
): PermissionRequirement | undefined {
  if (!metadata) return undefined;
  return 'select' in metadata ? metadata.select(body) : metadata;
}

export interface ScopeRequirement {
  /**
   * Optional override. Normally omitted: the resolver is whatever PART 6 grants this role
   * for this permission, read from the matrix, so a route cannot quietly widen its own
   * scope by naming a laxer resolver than the matrix allows.
   */
  resolver?: ScopeResolverName;
  /** Route parameter naming the single resource being addressed, if any. */
  param?: string;
  /** `read` returns 404 out of scope, `write` returns 403 (AZ-3). */
  intent?: 'read' | 'write';
}

/** Check 3 of §6.1: is the row inside the actor's scope? */
export const Scope = (requirement: ScopeRequirement = {}) => SetMetadata(SCOPE_KEY, requirement);

/**
 * Permits a route while `must_reset_password` is set. Only the reset endpoint itself and
 * `/auth/me` carry it — CH-1 requires the forced reset to block every other route.
 */
export const AllowPendingPasswordReset = () => SetMetadata(ALLOW_PENDING_RESET_KEY, true);

/** The resolved actor. Never trust a user ID from the body or the path instead of this. */
export const Actor = createParamDecorator((_data: unknown, _ctx: ExecutionContext): ActorContext => {
  const actor = getRequestContext()?.actor;
  if (!actor) {
    throw new Error('Actor requested on a route with no authenticated actor');
  }
  return actor;
});
