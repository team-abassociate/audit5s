import { Injectable } from '@nestjs/common';

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

/** The limits of ARCHITECTURE.md §12.11. Configuration, tunable without a deploy. */
export const RATE_LIMITS = {
  loginPerLoginId: { limit: 5, windowSeconds: 15 * 60 },
  loginPerIp: { limit: 20, windowSeconds: 15 * 60 },
  otpRequestPerPhone: { limit: 3, windowSeconds: 10 * 60 },
  otpRequestPerIp: { limit: 20, windowSeconds: 60 * 60 },
  refreshPerUser: { limit: 30, windowSeconds: 60 * 60 },
  globalPerUser: { limit: 600, windowSeconds: 60 },
  // §10.4, the public corrective-action page: the one surface reachable by anyone holding
  // a URL. The IP bucket is the one that limits walking the token space.
  correctiveActionPerToken: { limit: 10, windowSeconds: 60 },
  correctiveActionPerIp: { limit: 30, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

/** Progressive lockout begins at this many consecutive failures (§12.1). */
export const LOCKOUT_THRESHOLD = 10;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

/**
 * Sliding-window rate limiting.
 *
 * ARCHITECTURE.md §12.11 specified Redis; STACK.md §6 forbids it, and the deployment is a
 * single API container (STACK.md §4), so an in-process window is exact rather than an
 * approximation of a shared one. Two things make that acceptable rather than a shortcut:
 * Cloudflare's WAF rate-limits at the edge in front of this, and the security-critical
 * limit — failed logins per login ID — is counted from the `login_attempt` table instead,
 * so it survives a restart and cannot be reset by bouncing the process.
 *
 * If a second API replica is ever added, this becomes per-replica and the login-attempt
 * table stays authoritative. That is the tripwire to raise, not to work around.
 */
@Injectable()
export class RateLimitService {
  private readonly buckets = new Map<string, number[]>();

  consume(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitResult {
    const windowMs = rule.windowSeconds * 1000;
    const cutoff = now - windowMs;

    const hits = (this.buckets.get(key) ?? []).filter((at) => at > cutoff);

    if (hits.length >= rule.limit) {
      const oldest = hits[0] ?? now;
      const resetAt = new Date(oldest + windowMs);
      this.buckets.set(key, hits);
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)),
      };
    }

    hits.push(now);
    this.buckets.set(key, hits);

    return {
      allowed: true,
      remaining: rule.limit - hits.length,
      resetAt: new Date(now + windowMs),
      retryAfterSeconds: 0,
    };
  }

  /** Drops windows that have fully expired, so the map does not grow without bound. */
  sweep(now: number = Date.now()): void {
    const longestWindowMs =
      Math.max(...Object.values(RATE_LIMITS).map((rule) => rule.windowSeconds)) * 1000;
    for (const [key, hits] of this.buckets) {
      const live = hits.filter((at) => at > now - longestWindowMs);
      if (live.length === 0) {
        this.buckets.delete(key);
      } else {
        this.buckets.set(key, live);
      }
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}
