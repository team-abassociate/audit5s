import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '@audit5s/contracts';
import { normalizeNameForLoginId } from './login-id';

/**
 * Password policy (ARCHITECTURE.md §12.1): minimum 10 characters, checked against a
 * breached-password list and against the user's own phone and name.
 *
 * Pure and zero-IO. The breached-list lookup is a caller-supplied predicate so the large
 * list stays out of `packages/domain` and off the mobile bundle; the small embedded set
 * below catches the obvious cases even when no predicate is supplied.
 */

export type PasswordRejectionReason =
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'CONTAINS_PHONE'
  | 'CONTAINS_NAME'
  | 'CONTAINS_LOGIN_ID'
  | 'BREACHED'
  | 'COMMON';

export interface PasswordCheckInput {
  password: string;
  phoneE164: string;
  fullName: string;
  loginId?: string;
}

export interface PasswordCheckResult {
  ok: boolean;
  reasons: PasswordRejectionReason[];
}

/**
 * A deliberately small embedded set. The real defence is the injected breached-list
 * predicate; this only stops the passwords a user types when actively trying to get past
 * the form.
 */
const COMMON_PASSWORDS = new Set([
  'password123',
  'password1234',
  '1234567890',
  '0123456789',
  'qwertyuiop',
  'iloveyou123',
  'admin@12345',
  'welcome123',
  'letmein1234',
  'changeme123',
]);

/**
 * Shortest name fragment worth blacklisting. Below this the check costs more in false
 * rejections than it buys — "Li" would forbid every password containing "li".
 */
const NAME_PART_MIN_LENGTH = 4;

/** Digits only, so `+91 98765 43210` and `9876543210` compare equal. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

export function checkPassword(
  input: PasswordCheckInput,
  isBreached?: (password: string) => boolean,
): PasswordCheckResult {
  const reasons: PasswordRejectionReason[] = [];
  const { password, phoneE164, fullName, loginId } = input;

  if (password.length < PASSWORD_MIN_LENGTH) {
    reasons.push('TOO_SHORT');
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    reasons.push('TOO_LONG');
  }

  const lowered = password.toLowerCase();
  const passwordDigits = digitsOf(password);
  const phoneDigits = digitsOf(phoneE164);

  // The bootstrap credential is the phone number (CH-1). A reset that keeps any substantial
  // run of it has not actually rotated the credential.
  if (phoneDigits.length >= 4 && passwordDigits.includes(phoneDigits.slice(-7))) {
    reasons.push('CONTAINS_PHONE');
  }

  // Each name part is checked separately, not only the concatenation: "Rahul Sharma"
  // must reject "rahul2024!" as well as "rahulsharma99". Parts shorter than
  // NAME_PART_MIN_LENGTH are skipped, so an initial does not blacklist a common substring.
  const nameParts = fullName
    .split(/\s+/)
    .map(normalizeNameForLoginId)
    .filter((part) => part.length >= NAME_PART_MIN_LENGTH);
  const wholeName = normalizeNameForLoginId(fullName);
  if (wholeName.length >= NAME_PART_MIN_LENGTH) {
    nameParts.push(wholeName);
  }

  const loweredAlpha = lowered.replace(/[^a-z]/g, '');
  if (nameParts.some((part) => loweredAlpha.includes(part.toLowerCase()))) {
    reasons.push('CONTAINS_NAME');
  }

  if (loginId && lowered.includes(loginId.toLowerCase())) {
    reasons.push('CONTAINS_LOGIN_ID');
  }

  if (COMMON_PASSWORDS.has(lowered)) {
    reasons.push('COMMON');
  }
  if (isBreached?.(password)) {
    reasons.push('BREACHED');
  }

  return { ok: reasons.length === 0, reasons };
}

/** Human-readable text for each rejection, shown identically by web and mobile. */
export const PASSWORD_REJECTION_MESSAGES: Readonly<Record<PasswordRejectionReason, string>> = {
  TOO_SHORT: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  TOO_LONG: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  CONTAINS_PHONE: 'Password must not contain your phone number',
  CONTAINS_NAME: 'Password must not contain your name',
  CONTAINS_LOGIN_ID: 'Password must not contain your login ID',
  BREACHED: 'This password has appeared in a known breach. Choose another.',
  COMMON: 'This password is too common. Choose another.',
};
