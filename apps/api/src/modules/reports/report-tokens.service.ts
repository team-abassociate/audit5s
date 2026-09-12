import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type {
  ReportAccessToken,
  ReportTokenPurpose,
  RevokeTokenRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import type { Transaction } from '@audit5s/db';
import { AppError } from '../../common/errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { CONFIG, type AppConfig } from '../../config/env';
import {
  ReportTokensRepository,
  type ReportAccessTokenRow,
  type ResolvedToken,
} from './report-tokens.repository';

/**
 * Minting, validating and revoking a signed link (§10.4, §12.7).
 *
 * The security properties this class is responsible for, each of which is a line in
 * §10.4's table rather than a preference:
 *
 *   * **No enumeration.** The secret is 256 random bits and only its SHA-256 is stored, so
 *     nothing here can reproduce a link. An invalid token and an expired one return the
 *     same `410`, because distinguishing them would tell a prober which guesses were close.
 *   * **Not a session.** A resolved token authorizes two operations on one corrective
 *     action and grants no other API access. It never becomes a JWT and never refreshes.
 *   * **Single-item audience.** The token names one `corrective_action_id`; the public
 *     surface has no listing route for it to reach anything else through.
 *   * **Auditable.** Every use is recorded with IP and timestamp — including the uses that
 *     were refused, which are the interesting ones.
 */
@Injectable()
export class ReportTokensService {
  constructor(
    private readonly repository: ReportTokensRepository,
    private readonly auditLog: AuditLogService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Mint one link per corrective action, plus the report-level one (§10.2).
   *
   * Called **inside** the freeze transaction and **before** the render, because the PDF
   * prints the link: tokens minted after the render could not appear in the document they
   * belong to (DECISIONS.md R-14). The raw secrets are returned and never stored.
   */
  async mintForSnapshot(
    tx: Transaction,
    input: {
      snapshotId: string;
      unitId: string;
      createdByUserId: string;
      actions: readonly { id: string; assignedZoneLeaderUserId: string | null }[];
    },
  ): Promise<Map<string, string>> {
    const expiresAt = new Date(Date.now() + this.config.REPORT_TOKEN_TTL_DAYS * 86_400_000);
    const urls = new Map<string, string>();
    const rows = [];

    for (const action of input.actions) {
      const secret = mintSecret();
      rows.push({
        id: uuidv7(),
        tokenHash: hashToken(secret),
        purpose: 'CORRECTIVE_ACTION' satisfies ReportTokenPurpose,
        snapshotId: input.snapshotId,
        correctiveActionId: action.id,
        unitId: input.unitId,
        // "Bound to a Zone Leader where known" (§5.8) — and it is also *who a submission
        // through this link is attributed to*, because a public page has no session and
        // `corrective_action_submission.submitted_by_user_id` is NOT NULL.
        issuedToUserId: action.assignedZoneLeaderUserId,
        expiresAt,
        createdByUserId: input.createdByUserId,
      });
      urls.set(action.id, `${this.config.WEB_APP_URL.replace(/\/+$/, '')}/ca/${secret}`);
    }

    await this.repository.mint(tx, rows);
    return urls;
  }

  /**
   * Resolve a link, or refuse it the way §10.4 requires.
   *
   * Every refusal is the same `410 TOKEN_EXPIRED` with the same wording, whatever the
   * actual cause — absent, revoked, expired or spent. That is deliberate: a message that
   * distinguished them would tell somebody probing the surface which of their guesses
   * named a real finding.
   */
  async resolve(rawToken: string, ipAddress: string | null): Promise<ResolvedToken> {
    const resolved = looksLikeToken(rawToken)
      ? await this.repository.resolveAndRecordUse(hashToken(rawToken), ipAddress)
      : null;

    if (!resolved || !isUsable(resolved)) {
      throw gone();
    }
    if (resolved.purpose !== 'CORRECTIVE_ACTION' || !resolved.correctiveActionId) {
      throw gone();
    }
    return resolved;
  }

  async listForSnapshot(scope: ScopeContext, snapshotId: string): Promise<ReportAccessToken[]> {
    const rows = await this.repository.listForSnapshot(scope, snapshotId);
    return rows.map((row) => toContract(row.token, row));
  }

  /** `POST /reports/{id}/tokens/{tokenId}/revoke` — `AuditLog: report.token_revoked`. */
  async revoke(
    scope: ScopeContext,
    snapshotId: string,
    tokenId: string,
    request: RevokeTokenRequest,
  ): Promise<ReportAccessToken> {
    const before = await this.repository.findById(scope, tokenId);
    if (!before || before.snapshotId !== snapshotId) {
      throw AppError.notFound('No such link on this report');
    }

    const revoked = await this.repository.revoke(scope, tokenId, request.reason);
    if (revoked) {
      await this.auditLog.record({
        action: 'report.token_revoked',
        resourceType: 'report_access_token',
        resourceId: tokenId,
        unitId: before.unitId,
        before: { revokedAt: null },
        after: { revokedAt: new Date().toISOString(), reason: request.reason },
      });
    }

    const after = await this.repository.findById(scope, tokenId);
    return toContract(after ?? before, {});
  }
}

/** 256 bits, base64url. The only place a raw token value is ever produced. */
function mintSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * A cheap shape check before touching the database.
 *
 * Not a security control — the hash lookup is — but it keeps a request for `/ca/favicon.ico`
 * from becoming a database round trip, and there are a lot of those.
 */
function looksLikeToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,64}$/.test(value);
}

function isUsable(token: ReportAccessTokenRow & { issuedToRole?: string | null }): boolean {
  if (token.revokedAt) return false;
  if (token.expiresAt.getTime() <= Date.now()) return false;
  if (token.maxUses !== null && token.useCount > token.maxUses) return false;
  return true;
}

/**
 * The one refusal. `410` rather than `404` because §10.4 says so and because the
 * difference matters to the person holding the link: gone means "this link is finished,
 * ask for a new one", which is a path the page offers.
 */
export function gone(): AppError {
  return new AppError(
    'TOKEN_EXPIRED',
    410,
    'This link is no longer valid',
    'Ask your Super Admin for a new corrective-action link.',
  );
}

/** Unused, but kept honest: constant-time compare for any future direct token match. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function toContract(
  row: ReportAccessTokenRow,
  extra: { issuedToName?: string | null; zoneCode?: string | null; questionGlobalOrder?: number | null },
): ReportAccessToken {
  return {
    id: row.id,
    purpose: row.purpose as ReportTokenPurpose,
    snapshotId: row.snapshotId,
    correctiveActionId: row.correctiveActionId,
    unitId: row.unitId,
    issuedToUserId: row.issuedToUserId,
    issuedToName: extra.issuedToName ?? null,
    expiresAt: row.expiresAt.toISOString(),
    maxUses: row.maxUses,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByUserId: row.revokedByUserId,
    revokeReason: row.revokeReason,
    createdAt: row.createdAt.toISOString(),
    active: isUsable(row),
    zoneCode: extra.zoneCode ?? null,
    questionGlobalOrder: extra.questionGlobalOrder ?? null,
  };
}
