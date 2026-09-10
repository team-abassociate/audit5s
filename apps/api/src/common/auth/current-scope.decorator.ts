import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ScopeContext } from '@audit5s/domain';
import { scopeOf, type RequestWithScope } from './scope.guard';

/** Injects the `ScopeContext` the guard chain resolved. */
export const CurrentScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ScopeContext =>
    scopeOf(ctx.switchToHttp().getRequest<RequestWithScope>()),
);
