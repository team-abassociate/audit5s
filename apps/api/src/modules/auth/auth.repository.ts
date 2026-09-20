import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  devices,
  loginAttempts,
  otpChallenges,
  refreshTokens,
  revokedAccessTokens,
  users,
  withAuthPhase,
  type Database,
  type Transaction,
} from '@audit5s/db';
import { DATABASE } from '../../infrastructure/database/database.module';

/**
 * The authentication data access.
 *
 * Every query here runs inside `withAuthPhase`, which sets `app.auth_phase` for the
 * transaction. That is the one deliberate opening in the RLS scheme: `/auth/login` has to
 * read a user row before any actor exists. It unlocks the authentication tables only —
 * every business policy still requires a real actor, so a business path that forgets to
 * set a context sees nothing rather than everything.
 */
@Injectable()
export class AuthRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findByLoginId(loginId: string) {
    return withAuthPhase(this.db, async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(and(eq(users.loginId, loginId), isNull(users.archivedAt)))
        .limit(1);
      return user ?? null;
    });
  }

  async findById(userId: string) {
    return withAuthPhase(this.db, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      return user ?? null;
    });
  }

  /** Failed attempts in the window, counted from the table so a restart cannot reset them. */
  async recentFailureCount(loginId: string, windowSeconds: number): Promise<number> {
    return withAuthPhase(this.db, async (tx) => {
      const result = await tx.execute(
        sql`SELECT count(*)::int AS n FROM login_attempt
            WHERE login_id = ${loginId}
              AND succeeded = false
              AND occurred_at > now() - (${windowSeconds} * interval '1 second')`,
      );
      const rows = (result as unknown as { rows: Array<{ n: number }> }).rows;
      return rows[0]?.n ?? 0;
    });
  }

  async recordLoginAttempt(input: {
    loginId: string;
    userId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    deviceId: string | null;
    succeeded: boolean;
    failureCode: string | null;
  }): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx.insert(loginAttempts).values(input);
    });
  }

  async applyFailedLogin(userId: string, lockUntil: Date | null): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx
        .update(users)
        .set({
          failedLoginCount: sql`${users.failedLoginCount} + 1`,
          ...(lockUntil ? { lockedUntil: lockUntil, status: 'LOCKED' as const } : {}),
        })
        .where(eq(users.id, userId));
    });
  }

  async applySuccessfulLogin(userId: string, rehashedPassword: string | null): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx
        .update(users)
        .set({
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: sql`now()`,
          ...(rehashedPassword ? { passwordHash: rehashedPassword } : {}),
        })
        .where(eq(users.id, userId));
    });
  }

  async upsertDevice(input: {
    deviceId: string;
    userId: string;
    /**
     * Sent the first time a device signs in, and optional afterwards: a re-login from a
     * phone already on file needs no metadata. `null` against an unknown id is the one
     * combination that cannot be honoured, and it is reported rather than guessed at.
     */
    platform: string | null;
    model?: string | null;
    osVersion?: string | null;
    appVersion?: string | null;
    pushToken?: string | null;
    /**
     * The user this device belonged to before this login, when that was somebody else.
     * A handset is physical and its id is per-install, not per-user: signing in on it is
     * the act of taking it over, and it is the only moment anybody proves they hold the
     * credentials *on that device*. Before this, the upsert left `user_id` alone, so a
     * shared phone stayed with whoever logged in first and every audit the second auditor
     * started was refused for a device that was not theirs.
     *
     * The previous owner's unsynced work on the phone stops being reachable from it, and
     * any audit still locked to this device is released the documented way, through
     * `POST /audits/{id}/release-device`. That is why this is reported rather than
     * swallowed: the caller audit-logs it.
     */
  }): Promise<{ registered: boolean; transferredFromUserId: string | null }> {
    return withAuthPhase(this.db, async (tx) => {
      const [existing] = await tx
        .select({ userId: devices.userId, platform: devices.platform })
        .from(devices)
        .where(eq(devices.id, input.deviceId))
        .limit(1);

      // A new device with no platform cannot be written: the column is NOT NULL with a
      // two-value CHECK, and guessing would put a fiction in the device inventory. The
      // caller refuses the login instead — binding a session to it would only move the
      // failure to `refresh_token.device_id`, which references this table, and answer a
      // well-formed request with a foreign-key 500.
      if (!existing && !input.platform) {
        return { registered: false, transferredFromUserId: null };
      }

      // `ON CONFLICT DO UPDATE` still forms the candidate row, and `platform` is NOT NULL,
      // so a re-login that reports none has to carry the stored one through the VALUES
      // clause rather than a null the constraint would reject before seeing the conflict.
      const platform = input.platform ?? existing!.platform;

      await tx
        .insert(devices)
        .values({
          id: input.deviceId,
          userId: input.userId,
          platform,
          model: input.model ?? null,
          osVersion: input.osVersion ?? null,
          appVersion: input.appVersion ?? null,
          pushToken: input.pushToken ?? null,
          lastSeenAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: devices.id,
          set: {
            // Only what this login actually reported. A re-login that sends no metadata
            // must not blank the model and OS the first one recorded.
            platform,
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.osVersion !== undefined ? { osVersion: input.osVersion } : {}),
            ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
            ...(input.pushToken ? { pushToken: input.pushToken } : {}),
            lastSeenAt: sql`now()`,
            revokedAt: null,
            // The handover itself. Deliberately unconditional: a device row follows the
            // account that last signed in on the hardware.
            userId: input.userId,
          },
        });

      return {
        registered: true,
        transferredFromUserId:
          existing && existing.userId !== input.userId ? existing.userId : null,
      };
    });
  }

  async createRefreshToken(input: {
    userId: string;
    deviceId: string | null;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
  }): Promise<string> {
    return withAuthPhase(this.db, async (tx) => {
      const [row] = await tx.insert(refreshTokens).values(input).returning({ id: refreshTokens.id });
      return row!.id;
    });
  }

  async findRefreshTokenByHash(tokenHash: string) {
    return withAuthPhase(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * Rotation. The presented token is marked used and pointed at its replacement in one
   * transaction, so two concurrent refreshes cannot both succeed.
   */
  async rotateRefreshToken(input: {
    currentId: string;
    userId: string;
    deviceId: string | null;
    familyId: string;
    newTokenHash: string;
    expiresAt: Date;
  }): Promise<string | null> {
    return withAuthPhase(this.db, async (tx) => {
      const marked = await tx
        .update(refreshTokens)
        .set({ usedAt: sql`now()` })
        .where(and(eq(refreshTokens.id, input.currentId), isNull(refreshTokens.usedAt)))
        .returning({ id: refreshTokens.id });

      // Someone else rotated it first. The caller treats this as reuse.
      if (marked.length === 0) {
        return null;
      }

      const [created] = await tx
        .insert(refreshTokens)
        .values({
          userId: input.userId,
          deviceId: input.deviceId,
          tokenHash: input.newTokenHash,
          familyId: input.familyId,
          expiresAt: input.expiresAt,
        })
        .returning({ id: refreshTokens.id });

      await tx
        .update(refreshTokens)
        .set({ replacedById: created!.id })
        .where(eq(refreshTokens.id, input.currentId));

      return created!.id;
    });
  }

  /**
   * Invariant R-1: presenting an already-used refresh token revokes the **entire family**
   * and forces re-login. Standard reuse detection — the honest reading of a replayed token
   * is that one of the two holders is not the legitimate one, and neither can be told apart.
   */
  async revokeFamily(familyId: string): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
    });
  }

  async revokeAllUserTokens(userId: string, exceptFamilyId?: string): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(refreshTokens.userId, userId),
            isNull(refreshTokens.revokedAt),
            exceptFamilyId ? sql`${refreshTokens.familyId} <> ${exceptFamilyId}` : undefined,
          ),
        );
    });
  }

  /** Disables every credential surface for an administrator-revoked account. */
  async revokeUserAccess(userId: string): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
      await tx
        .update(devices)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
    });
  }

  async denyAccessToken(input: {
    jti: string;
    userId: string;
    expiresAt: Date;
    reason: string;
  }): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx.insert(revokedAccessTokens).values(input).onConflictDoNothing();
    });
  }

  async setPassword(input: {
    userId: string;
    passwordHash: string;
    mustResetPassword: boolean;
  }): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: input.passwordHash,
          mustResetPassword: input.mustResetPassword,
          bootstrapExpiresAt: null,
          status: 'ACTIVE',
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, input.userId));
    });
  }

  /**
   * Mints a reset token, superseding any the user already holds (0017).
   *
   * Superseding is the point: without it, asking twice leaves two working links, and the
   * older one is the more likely to have been intercepted — a forwarded mail, a shared
   * machine, a mailing list that kept a copy.
   */
  async issuePasswordReset(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    ipAddress: string | null;
  }): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx.execute(
        sql`SELECT app_issue_password_reset(
          ${input.userId}::uuid, ${input.tokenHash}, ${input.expiresAt}, ${input.ipAddress}
        )`,
      );
    });
  }

  /**
   * Spends a reset token and returns whose it was, or `null` if it is unknown, expired or
   * already used. The three are one answer on purpose — telling them apart would say
   * whether a token ever existed.
   *
   * Single-statement inside the function (0017), so two requests arriving together cannot
   * both spend it.
   */
  async redeemPasswordReset(tokenHash: string): Promise<string | null> {
    return withAuthPhase(this.db, async (tx) => {
      const result = await tx.execute(
        sql`SELECT app_redeem_password_reset(${tokenHash}) AS user_id`,
      );
      const row = result.rows[0] as { user_id: string | null } | undefined;
      return row?.user_id ?? null;
    });
  }

  async createOtpChallenge(input: {
    phoneE164: string;
    codeHash: string;
    expiresAt: Date;
    ipAddress: string | null;
  }): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx.insert(otpChallenges).values(input);
    });
  }

  async findActiveOtpChallenge(phoneE164: string) {
    return withAuthPhase(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(otpChallenges)
        .where(
          and(
            eq(otpChallenges.phoneE164, phoneE164),
            isNull(otpChallenges.consumedAt),
            gt(otpChallenges.expiresAt, new Date()),
          ),
        )
        .orderBy(sql`${otpChallenges.createdAt} DESC`)
        .limit(1);
      return row ?? null;
    });
  }

  async consumeOtpChallenge(id: string): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx.update(otpChallenges).set({ consumedAt: sql`now()` }).where(eq(otpChallenges.id, id));
    });
  }

  async incrementOtpAttempts(id: string): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx
        .update(otpChallenges)
        .set({ attemptCount: sql`${otpChallenges.attemptCount} + 1` })
        .where(eq(otpChallenges.id, id));
    });
  }

  /** Exposed for the seed and tests, which legitimately need a raw transaction. */
  runInAuthPhase<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return withAuthPhase(this.db, work);
  }
}
