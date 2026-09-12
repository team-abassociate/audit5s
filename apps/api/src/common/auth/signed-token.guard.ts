import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { ActorContext, SignedTokenScope } from '@audit5s/domain';
import { AppError } from '../errors';
import { getRequestContext, setActor } from '../observability/request-context';
import { ReportTokensService } from '../../modules/reports/report-tokens.service';
import { RATE_LIMITS, RateLimitService } from '../rate-limit/rate-limit.service';

export const SIGNED_TOKEN_KEY = 'audit5s:signed-token';

/**
 * Marks a route as authorized by a signed link rather than by a session (§8.8, §10.4).
 *
 * This is **not** `@Public()`. A public route has no actor and no scope; one of these has
 * both, and every later guard runs exactly as it does everywhere else — `PermissionGuard`
 * asks whether a Zone Leader may submit a corrective action at all, and `ScopeGuard`
 * narrows the request to the single item the link names. The only thing that changes is
 * *where the identity came from*.
 *
 * The route must take the raw token as a parameter named `token`.
 */
export const SignedTokenRoute = () => SetMetadata(SIGNED_TOKEN_KEY, true);

/** Where the resolved token is parked for `ScopeGuard` and the handler. */
export const SIGNED_TOKEN_PROPERTY = 'audit5sSignedToken';

export interface RequestWithSignedToken extends FastifyRequest {
  [SIGNED_TOKEN_PROPERTY]?: SignedTokenScope & { issuedToName: string | null };
}

/**
 * Check 1 of §6.1, for a request whose credential is a link.
 *
 * It runs **before** `JwtAuthGuard` — which skips a route carrying this metadata — and it
 * does the same three things that guard does: establish who the actor is, refuse if the
 * account behind them is gone, and put the result in the request context so everything
 * downstream is ordinary.
 *
 * The actor is the Zone Leader the token was issued to. That is not a convenience: a
 * submission's `submitted_by_user_id` is `NOT NULL` and its RLS insert policy requires it
 * to be the acting user, so a public page with no identity could not write one at all. A
 * token bound to nobody therefore authorizes reading the finding and not answering it,
 * which is the honest outcome and the one the page tells the reader about.
 *
 * §10.4's rate limits are applied here too, on the token and on the IP, because this is the
 * one surface reachable by anyone holding a URL.
 */
@Injectable()
export class SignedTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: ReportTokensService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isSignedTokenRoute = this.reflector.getAllAndOverride<boolean>(SIGNED_TOKEN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isSignedTokenRoute) return true;

    const request = context.switchToHttp().getRequest<RequestWithSignedToken>();
    const rawToken = (request.params as { token?: string } | undefined)?.token ?? '';
    const ipAddress = getRequestContext()?.ipAddress ?? null;

    // §10.4: "10 requests/min per token, 30/min per IP." The IP bucket is checked first —
    // it is the one that limits somebody walking the space of tokens, and spending it must
    // not require guessing a valid link.
    this.enforce(
      `ca-ip:${ipAddress ?? 'unknown'}`,
      RATE_LIMITS.correctiveActionPerIp,
    );
    this.enforce(`ca-token:${hashKey(rawToken)}`, RATE_LIMITS.correctiveActionPerToken);

    const resolved = await this.tokens.resolve(rawToken, ipAddress);

    if (!resolved.issuedToUserId || resolved.issuedToRole !== 'ZONE_LEADER') {
      // The link is valid; there is simply nobody it can act as. Refusing here rather than
      // later keeps every downstream write governed by a real actor and a real RLS policy.
      throw AppError.forbidden(
        'FORBIDDEN',
        'This corrective action has no Zone Leader assigned. Ask your Coordinator to assign one.',
      );
    }

    const actor: ActorContext = {
      userId: resolved.issuedToUserId,
      role: 'ZONE_LEADER',
      activeUnitId: resolved.unitId,
      unitIds: [resolved.unitId],
      // A link is not a device. Nothing on this surface writes a device-bound row.
      deviceId: null,
    };

    request[SIGNED_TOKEN_PROPERTY] = {
      tokenId: resolved.id,
      correctiveActionId: resolved.correctiveActionId!,
      unitId: resolved.unitId,
      issuedToName: resolved.issuedToName,
    };

    setActor(actor, `${resolved.issuedToName ?? 'Zone Leader'} (signed link)`);
    return true;
  }


  private enforce(key: string, rule: { limit: number; windowSeconds: number }): void {
    const result = this.rateLimit.consume(key, rule);
    if (!result.allowed) {
      throw AppError.rateLimited(
        `Too many requests. Try again in ${result.retryAfterSeconds} second(s).`,
      );
    }
  }
}

/** Never key a rate-limit bucket on a raw secret: buckets are logged. */
function hashKey(rawToken: string): string {
  let hash = 0;
  for (let index = 0; index < rawToken.length; index += 1) {
    hash = (hash * 31 + rawToken.charCodeAt(index)) | 0;
  }
  return String(hash >>> 0);
}
