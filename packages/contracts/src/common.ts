import { z } from 'zod';

/** Primitives shared by every request and response shape. */

export const uuidSchema = z.uuid();

/**
 * E.164. The bootstrap credential is derived from the last four digits of this value
 * (ARCHITECTURE.md §12.2), so its shape is validated at the boundary rather than assumed.
 */
export const phoneE164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be E.164, e.g. +919876543210');

export const emailSchema = z.email().trim().toLowerCase();

/**
 * Treats an empty string as absent.
 *
 * HTML forms submit `""` for every untouched optional field, so without this an optional
 * email or address fails validation the moment a user leaves it blank — which is the
 * normal case, not an edge case. Applied at the contract so both clients get it, rather
 * than each stripping empties on the way out.
 */
export function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
}

/**
 * Treats an empty string as an explicit `null`.
 *
 * The counterpart to `optional`, for *edit* forms: there, clearing a field means "remove
 * this value", not "leave it alone". Using `optional` on an update schema would silently
 * discard the clear.
 */
export function clearable<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    schema.nullable().optional(),
  );
}

/**
 * A boolean that arrives as a query-string word.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, so the string `"false"` is truthy and
 * `?active=false` silently means the opposite of what it says. Query booleans are read
 * through this instead, once, so no endpoint has to remember the trap.
 */
export function booleanQuery(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    return value;
  }, z.boolean().default(defaultValue));
}

/** ISO-8601 UTC with `Z` (ARCHITECTURE.md §8.1). */
export const isoDateTimeSchema = z.iso.datetime();

export const loginIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}\d{4}(-\d+)?$/, 'Login ID must look like RA3210 or RA3210-2');

/**
 * Cursor pagination (ARCHITECTURE.md §8.1). No offset paging on audit tables — an offset
 * over an append-only table silently skips rows as it grows.
 */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * Stable machine-readable error codes (ARCHITECTURE.md §8.1). Clients branch on `code`,
 * never on `title` or HTTP status alone.
 */
export const ERROR_CODES = [
  // Auth
  'INVALID_CREDENTIALS',
  'PASSWORD_RESET_REQUIRED',
  'BOOTSTRAP_CREDENTIAL_EXPIRED',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'TOKEN_REUSED',
  'TOKEN_AUDIENCE_MISMATCH',
  'ACCOUNT_LOCKED',
  'ACCOUNT_DISABLED',
  'WEAK_PASSWORD',
  'OTP_INVALID',
  'OTP_EXPIRED',
  // Authorization
  'FORBIDDEN',
  'NOT_FOUND',
  'FIELD_NOT_EDITABLE',
  'SCOPE_REVOKED',
  // Validation and conflict
  'VALIDATION_FAILED',
  'CONFLICT',
  'VERSION_CONFLICT',
  'DUPLICATE_CODE',
  'IDEMPOTENCY_KEY_REUSE',
  'LOGIN_ID_ALLOCATION_FAILED',
  'MEMBERSHIP_LIMIT_EXCEEDED',
  // Checklists and import
  'IMPORT_VALIDATION_FAILED',
  'IMPORT_NOT_PREVIEWED',
  'IMPORT_NO_CHANGES',
  'IMPORT_PREVIEW_EXPIRED',
  'IMPORT_FILE_REJECTED',
  'CHECKLIST_VERSION_NOT_DRAFT',
  'CHECKLIST_VERSION_IMMUTABLE',
  'ZONE_LEADER_NOT_IN_UNIT',
  // Audits and scoring
  'DEVICE_NOT_OWNER',
  'AUDIT_ALREADY_COMPLETED',
  'CHECKLIST_VERSION_MISMATCH',
  'ZONE_HAS_IN_PROGRESS_AUDIT',
  'INVALID_STATE_TRANSITION',
  'ZONE_ALREADY_IN_AUDIT',
  'ASSIGNMENT_REQUIRED',
  // Transport
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** One field-level validation failure inside a problem document. */
export const problemFieldErrorSchema = z.object({
  field: z.string(),
  message: z.string(),
});
export type ProblemFieldError = z.infer<typeof problemFieldErrorSchema>;

/** RFC 7807 `application/problem+json` (ARCHITECTURE.md §8.1). */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: errorCodeSchema,
  requestId: z.string(),
  errors: z.array(problemFieldErrorSchema).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Headers that carry meaning rather than transport detail. */
export const HEADER_REQUEST_ID = 'x-request-id';
export const HEADER_DEVICE_ID = 'x-device-id';
export const HEADER_IDEMPOTENCY_KEY = 'idempotency-key';

export const API_BASE_PATH = '/api/v1';
