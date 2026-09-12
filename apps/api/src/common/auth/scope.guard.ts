import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ScopeContext } from '@audit5s/domain';
import { grantFor, permissionKeyOf } from '@audit5s/domain';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { getRequestContext } from '../observability/request-context';
import {
  PERMISSION_KEY,
  PUBLIC_KEY,
  SCOPE_KEY,
  resolvePermission,
  type PermissionMetadata,
  type ScopeRequirement,
} from './decorators';
import {
  SIGNED_TOKEN_KEY,
  SIGNED_TOKEN_PROPERTY,
  type RequestWithSignedToken,
} from './signed-token.guard';

/** Where the resolved scope is parked for the handler and its repositories. */
export const SCOPE_CONTEXT_PROPERTY = 'audit5sScope';

export interface RequestWithScope extends FastifyRequest {
  [SCOPE_CONTEXT_PROPERTY]?: ScopeContext;
}

/**
 * Check 3 of §6.1 — the real gate.
 *
 * It does not decide anything by itself. It reads the scope resolver PART 6 grants this
 * role for this permission and attaches a `ScopeContext`; the repository then applies it
 * as a SQL predicate. That indirection is the point: the same definition governs "which
 * rows may I list" and "may I read this one", so they cannot drift apart.
 *
 * The resolver is taken from the matrix, not from the route. A route may narrow the
 * intent (read vs write) but cannot name a laxer resolver than its role was granted.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithScope>();
    const metadata = this.reflector.getAllAndOverride<PermissionMetadata>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requirement = resolvePermission(metadata, request.body);
    if (!requirement) {
      // PermissionGuard already refused; this is belt and braces for a reordered chain.
      throw AppError.forbidden('FORBIDDEN', 'This route declares no permission');
    }

    const actor = getRequestContext()?.actor;
    if (!actor) {
      throw AppError.unauthorized('TOKEN_INVALID', 'No authenticated actor');
    }

    const grant = grantFor(
      actor.role,
      permissionKeyOf({
        resource: requirement.resource,
        action: requirement.action,
        description: '',
        grants: {},
      }),
    );

    if (!grant) {
      throw AppError.forbidden();
    }

    const declared = this.reflector.getAllAndOverride<ScopeRequirement>(SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (declared?.resolver && declared.resolver !== grant.resolver) {
      // A route asking for a resolver the matrix did not grant is a wiring bug that would
      // otherwise widen access silently.
      throw AppError.internal(
        `Route declares scope '${declared.resolver}' but PART 6 grants '${grant.resolver}' ` +
          `to ${actor.role} for ${requirement.resource}:${requirement.action}`,
      );
    }

    /*
     * The signed-link surface takes `signed_token` instead of the matrix's own resolver,
     * and this is the one place a route's resolver differs from the cell's.
     *
     * It is not a widening, and PART 6 is where it comes from rather than an exception to
     * it: the Zone Leader cells this surface reaches read `assigned_actions` / `own_unit`
     * **"or via a valid signed token"**, and `signed_token` is strictly the narrower of
     * the two — one corrective action in one Unit, against a resolver that would otherwise
     * admit every action of that Unit (R-3b). A link cannot reach further than the person
     * holding it already could.
     */
    const bySignedToken = this.reflector.getAllAndOverride<boolean>(SIGNED_TOKEN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (bySignedToken) {
      const token = (request as RequestWithSignedToken)[SIGNED_TOKEN_PROPERTY];
      if (!token) {
        throw AppError.internal('Signed-token route reached with no resolved token');
      }
      request[SCOPE_CONTEXT_PROPERTY] = {
        actor,
        resolver: 'signed_token',
        condition: grant.condition ?? 'via a valid signed token',
        signedToken: {
          tokenId: token.tokenId,
          correctiveActionId: token.correctiveActionId,
          unitId: token.unitId,
        },
      };
      return true;
    }

    request[SCOPE_CONTEXT_PROPERTY] = {
      actor,
      resolver: grant.resolver,
      ...(grant.condition ? { condition: grant.condition } : {}),
    };

    return true;
  }
}

/** Reads the scope the guard attached. Handlers pass it straight to their repository. */
export function scopeOf(request: RequestWithScope): ScopeContext {
  const scope = request[SCOPE_CONTEXT_PROPERTY];
  if (!scope) {
    // Reaching a handler with no scope means the guard chain was bypassed. Refusing is the
    // only safe answer: continuing would run a query with no predicate.
    throw AppError.internal('No scope context on this request');
  }
  return scope;
}
