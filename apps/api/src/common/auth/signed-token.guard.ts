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
 * **Anyone holding the link may answer it** (R-22): the Super Admin sends the report to
 * whoever is responsible, who may have no account at all. A submission still needs an actor
 * — `submitted_by_user_id` is `NOT NULL` and its RLS insert policy requires the acting user
 * to be one who may answer the action — so the link acts as the Zone Leader it was issued
 * to when there is one, and otherwise as the Super Admin who generated the report. The
 * person's own typed name is what the attempt records as its author.
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

    const acting = linkActor(resolved);
    if (!acting) {
      // The link is valid, but nobody it could act as is still an active account — the
      // report's issuer has been disabled. Refusing here keeps every downstream write
      // governed by a real actor and a real RLS policy.
      throw AppError.forbidden(
        'FORBIDDEN',
        'This link can no longer be answered because the account that issued it is no longer active. Ask for a new link.',
      );
    }

    request[SIGNED_TOKEN_PROPERTY] = {
      tokenId: resolved.id,
      correctiveActionId: resolved.correctiveActionId!,
      unitId: resolved.unitId,
      issuedToName: resolved.issuedToName,
    };

    setActor(acting.actor, acting.label);
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

type ResolvedLink = Awaited<ReturnType<ReportTokensService['resolve']>>;

/**
 * Whom a link acts as (R-22).
 *
 * The Zone Leader it was issued to, when there is one; otherwise the Super Admin who
 * generated the report, who may answer any corrective action (R-18). Either way the scope
 * is still `signed_token`: one action, in one Unit, and the three routes of this surface.
 * `null` only when neither account is active any more.
 */
function linkActor(resolved: ResolvedLink): { actor: ActorContext; label: string } | null {
  // A link is not a device. Nothing on this surface writes a device-bound row.
  if (resolved.issuedToUserId && resolved.issuedToRole === 'ZONE_LEADER') {
    return {
      actor: {
        userId: resolved.issuedToUserId,
        role: 'ZONE_LEADER',
        activeUnitId: resolved.unitId,
        unitIds: [resolved.unitId],
        deviceId: null,
      },
      label: `${resolved.issuedToName ?? 'Zone Leader'} (signed link)`,
    };
  }
  if (resolved.issuedByRole === 'SUPER_ADMIN') {
    return {
      actor: {
        userId: resolved.createdByUserId,
        role: 'SUPER_ADMIN',
        activeUnitId: null,
        unitIds: [resolved.unitId],
        deviceId: null,
      },
      label: `Signed link issued by ${resolved.issuedByName ?? 'a Super Admin'}`,
    };
  }
  return null;
}

/** Never key a rate-limit bucket on a raw secret: buckets are logged. */
function hashKey(rawToken: string): string {
  let hash = 0;
  for (let index = 0; index < rawToken.length; index += 1) {
    hash = (hash * 31 + rawToken.charCodeAt(index)) | 0;
  }
  return String(hash >>> 0);
}
