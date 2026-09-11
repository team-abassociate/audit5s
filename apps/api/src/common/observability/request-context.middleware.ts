import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { HEADER_REQUEST_ID } from '@audit5s/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { runWithRequestContext } from './request-context';

/**
 * Establishes the request context and echoes `X-Request-Id` (ARCHITECTURE.md §8.1).
 *
 * A client-supplied request ID is honoured so a mobile sync batch can be traced end to
 * end, but it is bounded and stripped of anything that would corrupt a log line — it ends
 * up in `audit_log.request_id`, which is queried.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: FastifyRequest['raw'], reply: FastifyReply['raw'], next: () => void): void {
    const supplied = request.headers[HEADER_REQUEST_ID];
    const requestId = sanitizeRequestId(Array.isArray(supplied) ? supplied[0] : supplied);

    reply.setHeader(HEADER_REQUEST_ID, requestId);

    const forwardedFor = request.headers['x-forwarded-for'];
    const ipAddress =
      (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() ??
      request.socket.remoteAddress ??
      null;

    runWithRequestContext(
      {
        requestId,
        actor: null,
        actorLabel: null,
        ipAddress,
        userAgent: request.headers['user-agent'] ?? null,
        jti: null,
      },
      next,
    );
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function sanitizeRequestId(supplied: string | undefined): string {
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
}
