import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { checkPassword, type PasswordCheckResult } from '@audit5s/domain';
import { PASSWORD_REJECTION_MESSAGES } from '@audit5s/domain';
import { AppError } from '../../common/errors';

/**
 * Argon2id, tuned per ARCHITECTURE.md §12.1: m=64MiB, t=3, p=1 — roughly 250 ms on the
 * production Ampere hardware.
 *
 * These parameters are the security control, not a default to leave alone: a test asserts
 * them, so lowering them to speed up a test suite fails CI rather than silently weakening
 * every stored credential.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

export const PASSWORD_ALGO = 'argon2id';

@Injectable()
export class PasswordService {
  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, ARGON2_OPTIONS);
  }

  /**
   * Verifies, and reports whether the stored hash used weaker parameters than the current
   * ones — that is what `password_algo` and rehash-on-login exist for.
   */
  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      // A malformed hash is a verification failure, never an exception the caller must
      // distinguish — otherwise the error itself becomes an oracle.
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, ARGON2_OPTIONS);
    } catch {
      return true;
    }
  }

  /** Applies the §12.1 policy, throwing a problem document that names every failure. */
  assertAcceptable(input: {
    password: string;
    phoneE164: string;
    fullName: string;
    loginId: string;
  }): void {
    const result: PasswordCheckResult = checkPassword(input);
    if (!result.ok) {
      throw new AppError(
        'WEAK_PASSWORD',
        422,
        'Password rejected',
        result.reasons.map((reason) => PASSWORD_REJECTION_MESSAGES[reason]).join('; '),
        result.reasons.map((reason) => ({
          field: 'newPassword',
          message: PASSWORD_REJECTION_MESSAGES[reason],
        })),
      );
    }
  }
}
