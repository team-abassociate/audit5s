import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import {
  SERVER_FAULT_SENTENCE,
  heldItemSentence,
  isPlainSentence,
  presentHeldDetail,
  rawFailure,
} from './held-item-detail';

const INTERNALS = /select|update|insert|\$1|params|→|[A-Z]{4,}_?/;

/** What Drizzle throws for a failed statement: the SQL as the message, the driver error as the cause. */
function drizzleFailure(): Error {
  const cause = Object.assign(new Error('new row violates row-level security policy'), {
    code: '42501',
  });
  return new Error(
    'Failed query: update "evidence" set "byte_size" = $1, "sync_state" = $2 where "evidence"."id" = $3\nparams: 14850,SYNCED,01a0cd3a-147a-7591-9542-31e8ea911ab9',
    { cause },
  );
}

describe('held sync item detail (UX audit S1x)', () => {
  it('turns a database failure into a plain sentence and keeps the SQL for the log', () => {
    const error = drizzleFailure();
    const sentence = heldItemSentence(error, 'VALIDATION_FAILED');
    expect(sentence).toBe(SERVER_FAULT_SENTENCE);
    expect(sentence).not.toMatch(INTERNALS);

    const raw = rawFailure(error);
    expect(raw).toContain('Failed query');
    expect(raw).toContain('row-level security');
  });

  it('keeps a refusal the server wrote in plain words', () => {
    const error = AppError.conflict(
      'INVALID_STATE_TRANSITION',
      'This Zone was withdrawn from the audit. Start the Zone again to record answers for it.',
    );
    expect(heldItemSentence(error, 'VALIDATION_FAILED')).toBe(error.detail);
  });

  it('replaces a refusal that names enum states or guards', () => {
    const transition = AppError.conflict(
      'INVALID_STATE_TRANSITION',
      'This corrective action is VERIFIED; it is not waiting for a response',
    );
    expect(heldItemSentence(transition, 'VALIDATION_FAILED')).not.toMatch(INTERNALS);

    const guard = AppError.conflict('AUDIT_ALREADY_COMPLETED', 'audit → PAUSED is blocked: selfie_captured');
    const sentence = heldItemSentence(guard, 'AUDIT_ALREADY_COMPLETED');
    expect(sentence).toMatch(/already finished/);
    expect(isPlainSentence(sentence)).toBe(true);

    const rule = AppError.conflict(
      'AUDIT_ALREADY_COMPLETED',
      'This audit is completed. Use the post-completion override, which is audit-logged (A-2).',
    );
    expect(heldItemSentence(rule, 'AUDIT_ALREADY_COMPLETED')).toMatch(/already finished/);
    expect(presentHeldDetail('AUDIT_ALREADY_COMPLETED', rule.detail ?? null)).toMatch(/already finished/);

    const gate = AppError.conflict(
      'EVIDENCE_REQUIRED',
      'Zone Z-04 has no photograph. A walk-by records what was seen, so every Zone needs at least one (§7.1, §7.2).',
    );
    expect(heldItemSentence(gate, 'VALIDATION_FAILED')).toBe(
      'Zone Z-04 has no photograph. A walk-by records what was seen, so every Zone needs at least one.',
    );
  });

  it('names the fields of a malformed payload without quoting the enum it expected', () => {
    const schema = z.object({ value: z.enum(['SCORE_2', 'SCORE_1', 'SCORE_0', 'NA']) });
    const failure = schema.safeParse({ value: 'SCORE_9' });
    expect(failure.success).toBe(false);
    const sentence = heldItemSentence(failure.error, 'VALIDATION_FAILED');
    expect(sentence).toMatch(/value/);
    expect(sentence).not.toMatch(/SCORE/);
  });

  it('cleans rows that were stored with the raw message, on the way out', () => {
    expect(presentHeldDetail('VALIDATION_FAILED', drizzleFailure().message)).toBe(
      SERVER_FAULT_SENTENCE,
    );
    expect(presentHeldDetail('SCOPE_REVOKED', 'audit IN_PROGRESS → PAUSED is not permitted')).toMatch(
      /could not find this record/,
    );
    expect(presentHeldDetail('VALIDATION_FAILED', 'value: Required')).toBe('value: Required');
    expect(presentHeldDetail('VALIDATION_FAILED', null)).toBeNull();
  });
});
