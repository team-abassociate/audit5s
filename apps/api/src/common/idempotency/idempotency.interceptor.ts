import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { HEADER_IDEMPOTENCY_KEY } from '@audit5s/contracts';
import type { FastifyRequest } from 'fastify';
import { from, switchMap, tap, catchError, throwError, type Observable } from 'rxjs';
import { getRequestContext } from '../observability/request-context';
import { IdempotencyService } from './idempotency.service';

/**
 * Applies `Idempotency-Key` to every mutating request that supplies one.
 *
 * STACK.md §5 requires idempotency keys on mutating endpoints from the first commit,
 * because retrofitting them into an offline client already in the field means a forced
 * app update.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next.handle();
    }

    const rawKey = request.headers[HEADER_IDEMPOTENCY_KEY];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const actor = getRequestContext()?.actor;

    if (!key || !actor) {
      return next.handle();
    }

    const requestHash = IdempotencyService.hashRequest(request.body);
    const endpoint = `${method} ${request.routeOptions?.url ?? request.url}`;

    return from(
      this.idempotency.claim({ key, userId: actor.userId, endpoint, requestHash }),
    ).pipe(
      switchMap((replay) => {
        if (replay) {
          return from(Promise.resolve(replay.body));
        }
        return next.handle().pipe(
          tap((body) => {
            void this.idempotency.complete({
              key,
              userId: actor.userId,
              status: 200,
              body,
            });
          }),
          catchError((error: unknown) => {
            // A failed operation must not poison the key: the client's retry should run.
            void this.idempotency.release(key, actor.userId);
            return throwError(() => error);
          }),
        );
      }),
    );
  }
}
