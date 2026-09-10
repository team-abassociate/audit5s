/**
 * Login-ID generation (ARCHITECTURE.md §12.2).
 *
 *   normalize(name) → strip diacritics, drop non-alphabetic, uppercase
 *   take first 2     → "RAHUL SHARMA" → "RA"   ("A. B." → "AB";  "O'Neil" → "ON")
 *   last 4 of phone  → "+919876543210" → "3210"
 *   candidate        → "RA3210"
 *   collision        → "RA3210-2", "RA3210-3", …
 *
 * These IDs are deterministic and therefore enumerable. That is acceptable for a login
 * *identifier* precisely because the credential is separate and strong.
 *
 * Nothing here touches a database. Allocation runs inside the user-creation transaction
 * against `UNIQUE(login_id)`, walking these candidates until one inserts — the unique index
 * is the arbiter, so there is no read-then-write race.
 */

/** Attempts before the allocator gives up and fails loudly rather than looping forever. */
export const LOGIN_ID_MAX_ATTEMPTS = 50;

const PREFIX_LENGTH = 2;
const PHONE_SUFFIX_LENGTH = 4;
/** Padding for names with fewer than two letters after normalization: "A" → "AX". */
const PREFIX_PAD_CHAR = 'X';

/**
 * Strip diacritics, drop everything that is not a letter, uppercase.
 * "Ramírez" → "RAMIREZ";  "O'Neil" → "ONEIL";  "A. B." → "AB".
 */
export function normalizeNameForLoginId(fullName: string): string {
  return fullName
    .normalize('NFD')
    // Combining marks left behind by NFD.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
}

/** The two-letter prefix, padded with `X` when the name is too short. */
export function loginIdPrefix(fullName: string): string {
  const normalized = normalizeNameForLoginId(fullName);
  if (normalized.length === 0) {
    return PREFIX_PAD_CHAR.repeat(PREFIX_LENGTH);
  }
  return normalized.slice(0, PREFIX_LENGTH).padEnd(PREFIX_LENGTH, PREFIX_PAD_CHAR);
}

/**
 * The last four digits of the phone number. Non-digits are dropped first, so an E.164
 * value, a spaced national format and a hyphenated one all yield the same suffix.
 */
export function loginIdPhoneSuffix(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < PHONE_SUFFIX_LENGTH) {
    throw new Error(
      `Phone must contain at least ${PHONE_SUFFIX_LENGTH} digits to derive a login ID`,
    );
  }
  return digits.slice(-PHONE_SUFFIX_LENGTH);
}

/** The base candidate, before any collision suffix: "RA3210". */
export function loginIdBase(fullName: string, phone: string): string {
  return `${loginIdPrefix(fullName)}${loginIdPhoneSuffix(phone)}`;
}

/**
 * The nth candidate, zero-indexed. Attempt 0 is the bare base; every later attempt appends
 * `-2`, `-3`, … so the first collision produces "RA3210-2" rather than "RA3210-1".
 */
export function loginIdCandidate(fullName: string, phone: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error('attempt must be a non-negative integer');
  }
  const base = loginIdBase(fullName, phone);
  return attempt === 0 ? base : `${base}-${attempt + 1}`;
}

/**
 * Every candidate in order, for a caller that wants to drive the transactional insert loop
 * itself. Bounded by `LOGIN_ID_MAX_ATTEMPTS`; exhausting it is a loud failure, not a
 * silently truncated identifier.
 */
export function* loginIdCandidates(
  fullName: string,
  phone: string,
  maxAttempts: number = LOGIN_ID_MAX_ATTEMPTS,
): Generator<string, void, unknown> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    yield loginIdCandidate(fullName, phone, attempt);
  }
}
