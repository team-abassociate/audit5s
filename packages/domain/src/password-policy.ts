import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '@audit5s/contracts';

/**
 * Password policy. R-77 (owner, 2026-11-02) withdraws §12.1's rules: a password may be
 * anything the user wants — a name, a number, their phone — so long as it is not empty.
 * The upper bound stays only so Argon2 is never handed megabytes.
 */

export type PasswordRejectionReason = 'TOO_SHORT' | 'TOO_LONG';

export interface PasswordCheckInput {
  password: string;
  phoneE164?: string;
  fullName?: string;
  loginId?: string;
}

export interface PasswordCheckResult {
  ok: boolean;
  reasons: PasswordRejectionReason[];
}

export function checkPassword(input: PasswordCheckInput): PasswordCheckResult {
  const reasons: PasswordRejectionReason[] = [];
  if (input.password.length < PASSWORD_MIN_LENGTH) reasons.push('TOO_SHORT');
  if (input.password.length > PASSWORD_MAX_LENGTH) reasons.push('TOO_LONG');
  return { ok: reasons.length === 0, reasons };
}

/** Human-readable text for each rejection, shown identically by web and mobile. */
export const PASSWORD_REJECTION_MESSAGES: Readonly<Record<PasswordRejectionReason, string>> = {
  TOO_SHORT: 'Enter a password',
  TOO_LONG: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
};
