import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  permissionsForRole,
  type ActorContext,
} from '@audit5s/domain';
import type {
  AuthenticatedUser,
  ChangePasswordRequest,
  LoginRequest,
  LoginResponse,
  MeResponse,
  ResolvedScope,
  Role,
  TokenPair,
} from '@audit5s/contracts';
import { CONFIG, type AppConfig } from '../../config/env';
import { AppError } from '../../common/errors';
import { ActorRepository } from '../../common/auth/actor.repository';
import { TokenService, hashToken } from '../../common/auth/token.service';
import { getRequestContext } from '../../common/observability/request-context';
import {
  LOCKOUT_THRESHOLD,
  RATE_LIMITS,
  RateLimitService,
} from '../../common/rate-limit/rate-limit.service';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { AuthRepository } from './auth.repository';
import { EMAIL_CHANNEL, type EmailChannel } from '../../infrastructure/messaging/email-channel';
import { PasswordService } from './password.service';

type UserRow = NonNullable<Awaited<ReturnType<AuthRepository['findByLoginId']>>>;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly repository: AuthRepository,
    private readonly actors: ActorRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly rateLimits: RateLimitService,
    private readonly auditLog: AuditLogService,
    @Inject(EMAIL_CHANNEL) private readonly email: EmailChannel,
  ) {}

  async login(request: LoginRequest): Promise<LoginResponse> {
    const context = getRequestContext();
    const ipAddress = context?.ipAddress ?? null;

    this.enforceLoginRateLimits(request.loginId, ipAddress);

    const user = await this.repository.findByLoginId(request.loginId);

    // Both the unknown-login and wrong-password paths cost an Argon2 verification and
    // return the same problem document, so the endpoint is not a user-enumeration oracle.
    if (!user) {
      await this.passwords.verify(DUMMY_HASH, request.password);
      await this.recordFailure(request, null, 'INVALID_CREDENTIALS');
      throw AppError.unauthorized('INVALID_CREDENTIALS', 'Login ID or password is incorrect');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.recordFailure(request, user.id, 'ACCOUNT_LOCKED');
      throw AppError.unauthorized('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
    }

    if (user.status === 'DISABLED' || user.archivedAt !== null) {
      await this.recordFailure(request, user.id, 'ACCOUNT_DISABLED');
      throw AppError.unauthorized('ACCOUNT_DISABLED', 'This account is not active');
    }

    const passwordMatches = await this.passwords.verify(user.passwordHash, request.password);
    if (!passwordMatches) {
      await this.handleFailedPassword(user, request);
      throw AppError.unauthorized('INVALID_CREDENTIALS', 'Login ID or password is incorrect');
    }

    // CH-1: the bootstrap credential is the user's own phone number and expires in 72
    // hours. Past that it is not a password at all — an administrator must reissue one.
    if (user.mustResetPassword && user.bootstrapExpiresAt && user.bootstrapExpiresAt < new Date()) {
      await this.recordFailure(request, user.id, 'BOOTSTRAP_CREDENTIAL_EXPIRED');
      throw AppError.unauthorized(
        'BOOTSTRAP_CREDENTIAL_EXPIRED',
        'Your initial credential has expired. Ask an administrator to reissue it.',
      );
    }

    const rehashed = this.passwords.needsRehash(user.passwordHash)
      ? await this.passwords.hash(request.password)
      : null;

    await this.repository.applySuccessfulLogin(user.id, rehashed);

    if (request.deviceId && request.platform) {
      await this.repository.upsertDevice({
        deviceId: request.deviceId,
        userId: user.id,
        platform: request.platform,
        model: request.model ?? null,
        osVersion: request.osVersion ?? null,
        appVersion: request.appVersion ?? null,
      });
    }

    await this.repository.recordLoginAttempt({
      loginId: request.loginId,
      userId: user.id,
      ipAddress,
      userAgent: context?.userAgent ?? null,
      deviceId: request.deviceId ?? null,
      succeeded: true,
      failureCode: null,
    });

    const pair = await this.issueTokenPair(user.id, user.role as Role, request.deviceId ?? null, randomUUID());
    const scope = await this.resolveScope(user.id, request.deviceId ?? null);

    return {
      ...pair,
      user: toAuthenticatedUser(user),
      mustResetPassword: user.mustResetPassword,
      scope,
    };
  }

  /**
   * Rotation with reuse detection (invariant R-1).
   *
   * A refresh token is single-use. Presenting one that has already been used means either
   * the client replayed it or somebody stole it, and the two are indistinguishable — so
   * the entire family is revoked and everyone re-authenticates.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = hashToken(refreshToken);
    const stored = await this.repository.findRefreshTokenByHash(tokenHash);

    if (!stored) {
      throw AppError.unauthorized('TOKEN_INVALID', 'This refresh token is not valid');
    }

    if (stored.revokedAt) {
      throw AppError.unauthorized('TOKEN_INVALID', 'This session has been revoked');
    }

    if (stored.usedAt) {
      await this.repository.revokeFamily(stored.familyId);
      this.logger.warn(
        { userId: stored.userId, familyId: stored.familyId },
        'Refresh token reuse detected; family revoked',
      );
      throw AppError.unauthorized(
        'TOKEN_REUSED',
        'This refresh token was already used. All sessions have been ended; sign in again.',
      );
    }

    if (stored.expiresAt < new Date()) {
      throw AppError.unauthorized('TOKEN_EXPIRED', 'This refresh token has expired');
    }

    const limit = this.rateLimits.consume(`refresh:${stored.userId}`, RATE_LIMITS.refreshPerUser);
    if (!limit.allowed) {
      throw AppError.rateLimited(`Try again in ${limit.retryAfterSeconds} seconds`);
    }

    const user = await this.repository.findById(stored.userId);
    if (!user || user.archivedAt !== null || user.status !== 'ACTIVE') {
      await this.repository.revokeFamily(stored.familyId);
      throw AppError.unauthorized('ACCOUNT_DISABLED', 'This account is not active');
    }

    const next = this.tokens.issueRefreshToken();
    const rotated = await this.repository.rotateRefreshToken({
      currentId: stored.id,
      userId: stored.userId,
      deviceId: stored.deviceId,
      familyId: stored.familyId,
      newTokenHash: next.tokenHash,
      expiresAt: next.expiresAt,
    });

    // Lost the race against a concurrent refresh: that is reuse by any other name.
    if (!rotated) {
      await this.repository.revokeFamily(stored.familyId);
      throw AppError.unauthorized('TOKEN_REUSED', 'This refresh token was already used');
    }

    const access = await this.tokens.issueAccessToken({
      userId: user.id,
      role: user.role as Role,
      deviceId: stored.deviceId,
    });

    return {
      accessToken: access.token,
      refreshToken: next.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshTokenExpiresAt: next.expiresAt.toISOString(),
    };
  }

  /** Idempotent by design: logging out an already-dead session is still a 204. */
  async logout(refreshToken: string): Promise<void> {
    const stored = await this.repository.findRefreshTokenByHash(hashToken(refreshToken));
    if (stored) {
      await this.repository.revokeFamily(stored.familyId);
    }

    const context = getRequestContext();
    if (context?.jti && context.actor) {
      await this.repository.denyAccessToken({
        jti: context.jti,
        userId: context.actor.userId,
        expiresAt: new Date(Date.now() + this.config.ACCESS_TOKEN_TTL_SECONDS * 1000),
        reason: 'logout',
      });
    }
  }

  async changePassword(actor: ActorContext, request: ChangePasswordRequest): Promise<void> {
    const user = await this.repository.findById(actor.userId);
    if (!user) {
      throw AppError.unauthorized('TOKEN_INVALID');
    }

    if (!(await this.passwords.verify(user.passwordHash, request.currentPassword))) {
      throw AppError.unauthorized('INVALID_CREDENTIALS', 'Current password is incorrect');
    }

    this.passwords.assertAcceptable({
      password: request.newPassword,
      phoneE164: user.phoneE164,
      fullName: user.fullName,
      loginId: user.loginId,
    });

    await this.repository.setPassword({
      userId: user.id,
      passwordHash: await this.passwords.hash(request.newPassword),
      mustResetPassword: false,
    });

    // Changing a password ends every other session — that is the point of changing it.
    await this.repository.revokeAllUserTokens(user.id);

    await this.auditLog.recordSafely(
      { action: 'user.password_reset', resourceType: 'user', resourceId: user.id },
      `${user.fullName} (${user.loginId})`,
    );
  }

  /**
   * Always 202, whether or not the login ID exists (§8.3): a distinguishable response
   * here would turn the endpoint into a login-ID oracle.
   */
  async forgotPassword(loginId: string): Promise<void> {
    const context = getRequestContext();

    // Rate-limited on the login ID and the caller's address alike. Without the first, this
    // endpoint is a way to fill somebody's inbox; without the second, a way to fill many.
    const perLogin = this.rateLimits.consume(`reset:${loginId}`, RATE_LIMITS.otpRequestPerPhone);
    const perIp = this.rateLimits.consume(
      `reset-ip:${context?.ipAddress ?? 'unknown'}`,
      RATE_LIMITS.otpRequestPerIp,
    );
    // Silently, not with a 429: a rate-limit response distinguishable from the ordinary
    // one would answer "does this login ID exist" for anyone willing to ask twice.
    if (!perLogin.allowed || !perIp.allowed) return;

    const user = await this.repository.findByLoginId(loginId);
    if (!user) return;

    if (!user.email) {
      // Nothing to send to. Logged so an administrator can see why a user who asked never
      // received anything, and still answered 202 to the caller for the same reason as
      // above — the absence of an address is a fact about the account.
      this.logger.warn({ userId: user.id }, 'Password reset requested but no email on file');
      return;
    }

    // The raw token is never stored and never logged. This is the only moment it exists
    // outside the user's mailbox.
    const token = randomBytes(32).toString('base64url');
    const ttlMs = this.config.PASSWORD_RESET_TTL_MINUTES * 60_000;
    await this.repository.issuePasswordReset({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + ttlMs),
      ipAddress: context?.ipAddress ?? null,
    });

    const link = `${this.config.WEB_APP_URL}/reset-password?token=${token}`;
    const minutes = this.config.PASSWORD_RESET_TTL_MINUTES;
    try {
      await this.email.send({
        to: user.email,
        subject: 'Reset your audit5s password',
        // Lines joined rather than one escaped string: the message is read by a person in
        // a mail client, and it should be as easy to read here as it is there.
        text: [
          `Hello ${user.fullName},`,
          '',
          `Someone asked to reset the password for ${user.loginId}.`,
          'Open this link to choose a new one:',
          '',
          link,
          '',
          `The link works once and expires in ${minutes} minutes.`,
          '',
          'If this was not you, ignore this message — your password has not changed.',
          '',
        ].join('\n'),
      });
      this.logger.log({ userId: user.id }, 'Password reset link sent');
    } catch (error) {
      // The caller still gets 202. A send failure is an operator's problem, and reporting
      // it here would say that this login ID exists and has an address.
      this.logger.error(
        { userId: user.id, error: error instanceof Error ? error.message : String(error) },
        'Password reset link could not be sent',
      );
    }
  }

  /**
   * Completes a reset (§12.1). The token is the only credential: whoever holds it proved
   * they can read the account's mailbox, which is the whole basis of the flow.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const userId = await this.repository.redeemPasswordReset(hashToken(token));
    // Unknown, expired and already-spent are one answer. Telling them apart would say
    // whether a token ever existed, and a used one is the interesting case to an attacker.
    if (!userId) {
      throw AppError.unauthorized('RESET_TOKEN_INVALID', 'This reset link is no longer valid');
    }

    const user = await this.repository.findById(userId);
    if (!user) {
      throw AppError.unauthorized('RESET_TOKEN_INVALID', 'This reset link is no longer valid');
    }

    // The same strength rules a deliberate change is held to. A reset is the path someone
    // takes when they are in a hurry, which is exactly when a weak password gets chosen.
    this.passwords.assertAcceptable({
      password: newPassword,
      phoneE164: user.phoneE164,
      fullName: user.fullName,
      loginId: user.loginId,
    });

    await this.repository.setPassword({
      userId: user.id,
      passwordHash: await this.passwords.hash(newPassword),
      mustResetPassword: false,
    });

    // Every other session ends. Someone resetting a password they could not remember may
    // be locking an intruder out, and leaving that intruder's refresh token alive would
    // defeat the reset entirely.
    await this.repository.revokeAllUserTokens(user.id);

    await this.auditLog.recordSafely(
      { action: 'user.password_reset', resourceType: 'user', resourceId: user.id },
      `${user.fullName} (${user.loginId})`,
    );
  }

  async requestOtp(phone: string): Promise<void> {
    const context = getRequestContext();
    const perPhone = this.rateLimits.consume(`otp:${phone}`, RATE_LIMITS.otpRequestPerPhone);
    const perIp = this.rateLimits.consume(
      `otp-ip:${context?.ipAddress ?? 'unknown'}`,
      RATE_LIMITS.otpRequestPerIp,
    );
    if (!perPhone.allowed || !perIp.allowed) {
      throw AppError.rateLimited('Too many OTP requests. Try again later.');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.repository.createOtpChallenge({
      phoneE164: phone,
      codeHash: hashToken(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      ipAddress: context?.ipAddress ?? null,
    });

    // Scaffold only: the SMS/WhatsApp channel is an interface until Phase 6 (STACK.md §2).
    this.logger.log({ phone: '[phone]' }, 'OTP challenge created');
  }

  async verifyOtp(phone: string, code: string): Promise<LoginResponse> {
    const challenge = await this.repository.findActiveOtpChallenge(phone);
    if (!challenge) {
      throw AppError.unauthorized('OTP_EXPIRED', 'No active code for this number');
    }

    if (challenge.attemptCount >= OTP_MAX_ATTEMPTS) {
      await this.repository.consumeOtpChallenge(challenge.id);
      throw AppError.unauthorized('OTP_INVALID', 'Too many attempts. Request a new code.');
    }

    if (!constantTimeEquals(hashToken(code), challenge.codeHash)) {
      await this.repository.incrementOtpAttempts(challenge.id);
      throw AppError.unauthorized('OTP_INVALID', 'That code is not correct');
    }

    await this.repository.consumeOtpChallenge(challenge.id);

    // Scaffold, as Phase 1 specifies. The challenge lifecycle above is real and tested —
    // hashing, TTL, attempt ceiling, single use — but issuing a session from a phone
    // number alone needs the phone-to-user binding and the delivery channel, which arrive
    // with notifications in Phase 6. Refusing here is honest; minting a token would not be.
    throw AppError.unauthorized(
      'OTP_INVALID',
      'OTP sign-in is not enabled yet; use your login ID and password',
    );
  }

  async me(actor: ActorContext): Promise<MeResponse> {
    const user = await this.repository.findById(actor.userId);
    if (!user) {
      throw AppError.unauthorized('TOKEN_INVALID');
    }
    return {
      user: toAuthenticatedUser(user),
      scope: await this.resolveScope(actor.userId, actor.deviceId),
    };
  }

  /**
   * The server-resolved scope (§8.3). Clients render navigation from this and never
   * compute permissions themselves.
   */
  async resolveScope(userId: string, deviceId: string | null): Promise<ResolvedScope> {
    const record = await this.actors.loadActor(userId, deviceId);
    if (!record) {
      throw AppError.unauthorized('TOKEN_INVALID');
    }
    return {
      role: record.actor.role,
      unitIds: record.actor.unitIds,
      organizationWide: record.actor.role === 'SUPER_ADMIN',
      permissions: permissionsForRole(record.actor.role),
    };
  }

  async issueTokenPair(
    userId: string,
    role: Role,
    deviceId: string | null,
    familyId: string,
  ): Promise<TokenPair> {
    const access = await this.tokens.issueAccessToken({ userId, role, deviceId });
    const refresh = this.tokens.issueRefreshToken();

    await this.repository.createRefreshToken({
      userId,
      deviceId,
      tokenHash: refresh.tokenHash,
      familyId,
      expiresAt: refresh.expiresAt,
    });

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
    };
  }

  private enforceLoginRateLimits(loginId: string, ipAddress: string | null): void {
    const perLoginId = this.rateLimits.consume(`login:${loginId}`, RATE_LIMITS.loginPerLoginId);
    const perIp = this.rateLimits.consume(
      `login-ip:${ipAddress ?? 'unknown'}`,
      RATE_LIMITS.loginPerIp,
    );

    if (!perLoginId.allowed || !perIp.allowed) {
      const retryAfter = Math.max(perLoginId.retryAfterSeconds, perIp.retryAfterSeconds);
      throw AppError.rateLimited(`Too many attempts. Try again in ${retryAfter} seconds.`);
    }
  }

  private async handleFailedPassword(user: UserRow, request: LoginRequest): Promise<void> {
    await this.recordFailure(request, user.id, 'INVALID_CREDENTIALS');

    // Counted from the table rather than a counter in memory, so bouncing the process
    // does not hand an attacker a fresh budget.
    const failures = await this.repository.recentFailureCount(
      request.loginId,
      RATE_LIMITS.loginPerLoginId.windowSeconds,
    );

    const lockUntil =
      failures >= LOCKOUT_THRESHOLD
        ? new Date(Date.now() + RATE_LIMITS.loginPerLoginId.windowSeconds * 1000)
        : null;

    await this.repository.applyFailedLogin(user.id, lockUntil);
  }

  private async recordFailure(
    request: LoginRequest,
    userId: string | null,
    failureCode: string,
  ): Promise<void> {
    const context = getRequestContext();
    await this.repository.recordLoginAttempt({
      loginId: request.loginId,
      userId,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      deviceId: request.deviceId ?? null,
      succeeded: false,
      failureCode,
    });
  }
}

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

/**
 * A real Argon2id hash of a value nobody holds. Verifying against it on the unknown-login
 * path costs the same as a real verification, so response timing does not reveal whether
 * an account exists.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHRzb21lc2FsdA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function toAuthenticatedUser(user: UserRow): AuthenticatedUser {
  return {
    id: user.id,
    loginId: user.loginId,
    fullName: user.fullName,
    phoneE164: user.phoneE164,
    email: user.email,
    role: user.role as Role,
    status: user.status,
    mustResetPassword: user.mustResetPassword,
    bootstrapExpiresAt: user.bootstrapExpiresAt?.toISOString() ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}
