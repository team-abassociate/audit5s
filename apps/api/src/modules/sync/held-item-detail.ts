import type { SyncConflictReason } from '@audit5s/contracts';
import { AppError } from '../../common/errors';

/**
 * The sentence a held sync item carries to Sync Health and back to the device.
 *
 * `detail` used to be the thrown error's message, verbatim. For a database failure that is
 * Drizzle's wrapper — `Failed query: update "evidence" set … params: …` — so the browser
 * showed a Super Admin the SQL, the bound values and the enum tokens of a state machine
 * (UX audit S1x). That is a disclosure, and it is also unreadable.
 *
 * So the detail is a plain sentence, and the raw error goes to the server log only. The
 * stable code a Super Admin filters on is still `reason`; this module never changes it.
 *
 * Sanitising happens on write (new rows store the sentence) **and** on read (rows held
 * before this change stored the raw message, and they are still in the queue).
 */

/** Said for any failure that was the server's fault, not the payload's. */
export const SERVER_FAULT_SENTENCE =
  'The server hit an error of its own while saving this item; what the device sent is kept here in full.';

/** Said when the refusal's own words cannot be shown, by the category it was filed under. */
const REASON_SENTENCE: Record<SyncConflictReason, string> = {
  AUDIT_ALREADY_COMPLETED: 'The audit was already finished when this arrived from the device.',
  DEVICE_NOT_OWNER:
    'Another device is recording this audit, so this change from a second device was not applied.',
  CHECKLIST_VERSION_MISMATCH:
    'This question is not in the checklist version the audit was started with.',
  SCOPE_REVOKED:
    'The server could not find this record, or the person who sent it is no longer allowed to change it.',
  VALIDATION_FAILED: 'The server does not accept this item in the form the device sent it.',
};

/** Error codes that get a sentence of their own rather than their category's. */
const CODE_SENTENCE: Record<string, string> = {
  INVALID_STATE_TRANSITION:
    'This had already moved on to another stage when it arrived, so the change no longer applied.',
};

// What may never reach a person. SQL and its bound parameters; stack frames; arrows from
// state-machine refusals; snake_case column and guard names; SCREAMING enum tokens; a
// spec reference in brackets — "(A-2)", "(§9.5)" — which reads as jargon on the floor.
const SQL = /failed query|params:|\$\d|\b(select|insert|update|delete)\b[\s\S]*\b(from|into|set|where|values)\b/i;
const INTERNALS = /→|->|\bat \S+ \(|\b[a-z]+_[a-z_]+\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[A-Z]{4,}\b|\((?:[A-Z]{1,3}-\d|§)/;

/** True when a sentence carries nothing a person should not be shown. */
export function isPlainSentence(text: string): boolean {
  return !SQL.test(text) && !INTERNALS.test(text);
}

/** `checklistQuestionId` → `checklist question id`; list indexes dropped. */
function humaniseField(path: string): string {
  return path
    .split('.')
    .filter((segment) => segment !== '' && !/^\d+$/.test(segment))
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function fieldsSentence(paths: string[]): string {
  const fields = [...new Set(paths.map(humaniseField).filter((field) => field.length > 0))];
  return fields.length > 0
    ? `The device sent a value the server does not accept for: ${fields.join(', ')}.`
    : REASON_SENTENCE.VALIDATION_FAILED;
}

/**
 * The person-facing sentence for a failure thrown while applying a sync item.
 *
 * `reason` is the category the item is being filed under, or null when it is not held.
 */
export function heldItemSentence(error: unknown, reason: SyncConflictReason | null): string {
  if (error instanceof AppError) {
    if (error.getStatus() >= 500) {
      return SERVER_FAULT_SENTENCE;
    }
    if (error.fieldErrors && error.fieldErrors.length > 0) {
      return fieldsSentence(error.fieldErrors.map((e) => e.field));
    }
    const own = error.detail ?? '';
    if (own && isPlainSentence(own)) {
      return own;
    }
    return CODE_SENTENCE[error.code] ?? REASON_SENTENCE[reason ?? 'VALIDATION_FAILED'];
  }
  if (error && typeof error === 'object' && 'issues' in error) {
    // A Zod failure from one of the shared schemas: name the fields, not the rule's wording,
    // which quotes the enum it expected.
    const issues = (error as { issues: Array<{ path: unknown[] }> }).issues;
    return fieldsSentence(issues.map((issue) => issue.path.map(String).join('.')));
  }
  // Anything else — a database error above all — is the server's, and its message is SQL.
  return SERVER_FAULT_SENTENCE;
}

/**
 * The detail as read back for Sync Health. A row held before this change may carry the raw
 * message; it is replaced, never shown.
 */
export function presentHeldDetail(reason: string, detail: string | null): string | null {
  if (detail === null || isPlainSentence(detail)) {
    return detail;
  }
  if (SQL.test(detail) || /\bat \S+ \(/.test(detail)) {
    return SERVER_FAULT_SENTENCE;
  }
  return REASON_SENTENCE[reason as SyncConflictReason] ?? REASON_SENTENCE.VALIDATION_FAILED;
}

/** The raw failure, for the server log only: the message and its `cause` chain. */
export function rawFailure(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof AppError) {
      const fields = current.fieldErrors?.map((e) => `${e.field}: ${e.message}`) ?? [];
      parts.push(`${current.code}: ${current.detail ?? current.title}${fields.length ? ` [${fields.join('; ')}]` : ''}`);
    } else if (typeof current === 'object' && 'issues' in current) {
      const issues = (current as { issues: Array<{ path: unknown[]; message: string }> }).issues;
      parts.push(issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
    } else if (current instanceof Error) {
      parts.push(current.message);
    } else {
      parts.push(String(current));
    }
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return parts.join(' <- caused by: ');
}
