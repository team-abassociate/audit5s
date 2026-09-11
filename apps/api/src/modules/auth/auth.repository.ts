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
    platform: string;
    model?: string | null;
    osVersion?: string | null;
    appVersion?: string | null;
    pushToken?: string | null;
  }): Promise<void> {
    await withAuthPhase(this.db, async (tx) => {
      await tx
        .insert(devices)
        .values({
          id: input.deviceId,
          userId: input.userId,
          platform: input.platform,
          model: input.model ?? null,
          osVersion: input.osVersion ?? null,
          appVersion: input.appVersion ?? null,
          pushToken: input.pushToken ?? null,
          lastSeenAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: devices.id,
          set: {
            model: input.model ?? null,
            osVersion: input.osVersion ?? null,
            appVersion: input.appVersion ?? null,
            ...(input.pushToken ? { pushToken: input.pushToken } : {}),
            lastSeenAt: sql`now()`,
            revokedAt: null,
          },
        });
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
