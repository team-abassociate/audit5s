import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ScopeContext } from '@audit5s/domain';
import { grantFor, permissionKeyOf } from '@audit5s/domain';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { getRequestContext } from '../observability/request-context';
import { PERMISSION_KEY, PUBLIC_KEY, SCOPE_KEY, type PermissionRequirement, type ScopeRequirement } from './decorators';

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

    const requirement = this.reflector.getAllAndOverride<PermissionRequirement>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
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

    const request = context.switchToHttp().getRequest<RequestWithScope>();
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
