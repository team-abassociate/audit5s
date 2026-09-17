import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { accessTokenClaimsSchema, type AccessTokenClaims, type Role } from '@audit5s/contracts';
import { SignJWT, importPKCS8, importSPKI, jwtVerify, type KeyLike } from 'jose';
import { CONFIG, type AppConfig } from '../../config/env';
import { AppError } from '../errors';

export interface IssuedAccessToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

export interface IssuedRefreshToken {
  /** The opaque token handed to the client. Never stored. */
  token: string;
  /** SHA-256 of the token — this is what the database holds. */
  tokenHash: string;
  expiresAt: Date;
}

/**
 * Access and refresh tokens (ARCHITECTURE.md §12.3).
 *
 * Access: RS256, 15 minutes, claims `sub`, `role`, `jti`, `deviceId` and nothing more.
 * **No permissions and no unit IDs live in the token** — scope is resolved from the
 * database on every request, so revoking a Unit assignment takes effect immediately
 * rather than whenever the token happens to expire.
 *
 * Refresh: opaque 256-bit random, stored only as a SHA-256 hash, rotated on every use.
 */
@Injectable()
export class TokenService implements OnModuleInit {
  private privateKey!: KeyLike;
  private publicKey!: KeyLike;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    this.privateKey = await importPKCS8(this.config.jwtPrivateKeyPem, 'RS256');
    this.publicKey = await importSPKI(this.config.jwtPublicKeyPem, 'RS256');
  }

  async issueAccessToken(input: {
    userId: string;
    role: Role;
    deviceId: string | null;
  }): Promise<IssuedAccessToken> {
    const jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.config.ACCESS_TOKEN_TTL_SECONDS;

    const token = await new SignJWT({ role: input.role, deviceId: input.deviceId })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setSubject(input.userId)
      .setJti(jti)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setIssuer(this.config.JWT_ISSUER)
      .setAudience(this.config.JWT_AUDIENCE)
      .sign(this.privateKey);

    return { token, jti, expiresAt: new Date(exp * 1000) };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: this.config.JWT_ISSUER,
        audience: this.config.JWT_AUDIENCE,
        algorithms: ['RS256'],
      });
      return accessTokenClaimsSchema.parse(payload);
    } catch (error) {
      const expired =
        error instanceof Error && error.message.toLowerCase().includes('exp');
      throw AppError.unauthorized(
        expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
        'The access token is not valid',
      );
    }
  }

  /**
   * With `REFRESH_TOKEN_TTL_DAYS=0` (the default, R-21) a session has no time limit. It
   * still ends on sign-out, a password change, refresh-token reuse, or a disabled account.
   */
  issueRefreshToken(): IssuedRefreshToken {
    const token = randomBytes(32).toString('base64url');
    const days = this.config.REFRESH_TOKEN_TTL_DAYS;
    const expiresAt = days === 0 ? NEVER : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return { token, tokenHash: hashToken(token), expiresAt };
  }
}

/** "No limit". `refresh_token.expires_at` is NOT NULL, so never is the last day there is. */
const NEVER = new Date('9999-12-31T23:59:59.999Z');

/** SHA-256, hex. Used for refresh tokens and OTP codes alike — neither is ever stored raw. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
