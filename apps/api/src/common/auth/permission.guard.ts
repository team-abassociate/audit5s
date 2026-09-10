import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { grantFor, permissionKeyOf } from '@audit5s/domain';
import { AppError } from '../errors';
import { getRequestContext } from '../observability/request-context';
import { PERMISSION_KEY, PUBLIC_KEY, type PermissionRequirement } from './decorators';

/**
 * Check 2 of §6.1: does the role hold `(resource, action)` at all?
 *
 * This is the coarse gate. Failing it is a 403 — the actor's role cannot perform this
 * operation anywhere, so there is nothing to hide by pretending the route is absent. That
 * is the Consultant-posting-to-/reports/generate case in §6.4 (N5).
 *
 * A route with no `@RequirePermission` and no `@Public` is refused outright. An unguarded
 * endpoint is a bug, not a shortcut (STACK.md §1), and this is where that is made true
 * rather than merely asserted.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
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
      throw AppError.forbidden(
        'FORBIDDEN',
        'This route declares no permission. Add @RequirePermission or @Public.',
      );
    }

    const actor = getRequestContext()?.actor;
    if (!actor) {
      throw AppError.unauthorized('TOKEN_INVALID', 'No authenticated actor');
    }

    const key = permissionKeyOf({
      resource: requirement.resource,
      action: requirement.action,
      description: '',
      grants: {},
    });

    if (!grantFor(actor.role, key)) {
      throw AppError.forbidden('FORBIDDEN', `Your role may not ${requirement.action} a ${requirement.resource}`);
    }

    return true;
  }
}
