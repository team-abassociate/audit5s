import { describe, expect, it } from 'vitest';
import { SYNC_ENTITY_TYPES } from '@audit5s/contracts';
import {
  MAX_SYNC_ATTEMPTS,
  MAX_SYNC_BATCH_ITEMS,
  STALE_SYNCING_MS,
  decideRetry,
  isRetryableStatus,
  isStaleSyncing,
  nextRetryDelayMs,
  normalizeToServerTime,
  serverTimeOffsetMs,
  sortSyncItems,
  type OrderableSyncItem,
} from './sync-policy';

/** §9.3's ordering: `audit → audit_zone → question_response → evidence`. */
describe('topological ordering', () => {
  const item = (
    entityType: OrderableSyncItem['entityType'],
    operation: OrderableSyncItem['operation'],
    createdAt = '2026-09-09T10:00:00.000Z',
  ): OrderableSyncItem => ({ entityType, operation, createdAt });

  it('sorts a shuffled queue into parent-before-child order', () => {
    const shuffled = [
      item('evidence', 'commit'),
      item('question_response', 'upsert'),
      item('audit', 'upsert'),
      item('evidence', 'upsert'),
      item('audit_zone', 'upsert'),
    ];

    expect(sortSyncItems(shuffled).map((entry) => `${entry.entityType}:${entry.operation}`)).toEqual([
      'audit:upsert',
      'audit_zone:upsert',
      'question_response:upsert',
      'evidence:upsert',
      'evidence:commit',
    ]);
  });

  it('puts evidence commit after evidence metadata, because the bytes go between them', () => {
    const sorted = sortSyncItems([item('evidence', 'commit'), item('evidence', 'upsert')]);
    expect(sorted[0]!.operation).toBe('upsert');
  });

  it('completes a Zone after answering it', () => {
    const sorted = sortSyncItems([
      item('audit_zone', 'complete'),
      item('audit_zone', 'upsert'),
      item('question_response', 'upsert'),
    ]);
    // The Zone is created, the answers land, and only then is it finished — otherwise the
    // server's `all_questions_answered` guard refuses a Zone that is in fact complete.
    expect(sorted.map((entry) => `${entry.entityType}:${entry.operation}`)).toEqual([
      'audit_zone:upsert',
      'question_response:upsert',
      'audit_zone:complete',
    ]);
  });

  it('completes children before parents, the reverse of how it creates them', () => {
    const sorted = sortSyncItems([
      item('audit', 'complete'),
      item('audit_zone', 'complete'),
      item('audit', 'upsert'),
      item('audit_zone', 'upsert'),
    ]);
    // Creation descends the hierarchy, completion climbs back up it. An audit completed
    // before its Zones would be refused by `all_zones_completed`.
    expect(sorted.map((entry) => `${entry.entityType}:${entry.operation}`)).toEqual([
      'audit:upsert',
      'audit_zone:upsert',
      'audit_zone:complete',
      'audit:complete',
    ]);
  });

  it('sends the whole of a three-Zone offline audit in an order the server accepts', () => {
    // The acceptance shape: one audit, three Zones, their answers, an abort and a resume.
    const queue: OrderableSyncItem[] = [
      item('audit', 'complete', '2026-09-09T12:00:00.000Z'),
      item('audit_zone', 'complete', '2026-09-09T11:00:00.000Z'),
      item('question_response', 'upsert', '2026-09-09T10:30:00.000Z'),
      item('audit', 'resume', '2026-09-09T10:20:00.000Z'),
      item('audit', 'pause', '2026-09-09T10:10:00.000Z'),
      item('audit_zone', 'upsert', '2026-09-09T10:05:00.000Z'),
      item('audit', 'upsert', '2026-09-09T10:00:00.000Z'),
      item('evidence', 'commit', '2026-09-09T10:40:00.000Z'),
      item('evidence', 'upsert', '2026-09-09T10:35:00.000Z'),
    ];

    expect(sortSyncItems(queue).map((entry) => `${entry.entityType}:${entry.operation}`)).toEqual([
      'audit:upsert',
      'audit_zone:upsert',
      'question_response:upsert',
      'evidence:upsert',
      'evidence:commit',
      // The abort's cursors reference an audit Zone, which by now exists.
      'audit:pause',
      'audit:resume',
      'audit_zone:complete',
      'audit:complete',
    ]);
  });

  it('keeps author order among equals', () => {
    const sorted = sortSyncItems([
      item('question_response', 'upsert', '2026-09-09T10:00:05.000Z'),
      item('question_response', 'upsert', '2026-09-09T10:00:01.000Z'),
    ]);
    expect(sorted[0]!.createdAt).toBe('2026-09-09T10:00:01.000Z');
  });

  it('does not mutate its input', () => {
    const original = [item('evidence', 'upsert'), item('audit', 'upsert')];
    const before = original.map((entry) => entry.entityType);
    sortSyncItems(original);
    expect(original.map((entry) => entry.entityType)).toEqual(before);
  });

  it('ranks every entity type the contract declares', () => {
    const sorted = sortSyncItems(SYNC_ENTITY_TYPES.map((entity) => item(entity, 'upsert')));
    expect(sorted.map((entry) => entry.entityType)).toEqual([...SYNC_ENTITY_TYPES]);
  });

  it('batches at most 100 items (§9.3)', () => {
    expect(MAX_SYNC_BATCH_ITEMS).toBe(100);
  });
});

/**
 * §9.3's retry policy. The clause worth the most tests is the last one:
 *
 * > `4xx` other than `408`/`429` is **not** retried — it is a bug, and retrying it forever
 * > hides the bug.
 */
describe('retry policy', () => {
  it('retries a network failure with no status at all', () => {
    expect(isRetryableStatus(null)).toBe(true);
    expect(isRetryableStatus(undefined)).toBe(true);
  });

  it('retries 5xx', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it('retries exactly 408 and 429 among the 4xx', () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 413, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('gives up immediately on a non-retryable status rather than burning eight attempts', () => {
    expect(decideRetry({ attempts: 1, status: 422 })).toEqual({
      retry: false,
      reason: 'NOT_RETRYABLE',
    });
  });

  it('dead-letters after eight attempts, and never discards', () => {
    expect(MAX_SYNC_ATTEMPTS).toBe(8);
    expect(decideRetry({ attempts: 8, status: 503, random: () => 0.5 })).toEqual({
      retry: false,
      reason: 'DEAD_LETTER',
    });
    // The seventh still retries: the boundary is "attempts made", not "attempts left".
    const seventh = decideRetry({ attempts: 7, status: 503, random: () => 0.5 });
    expect(seventh.retry).toBe(true);
  });
});

describe('backoff with full jitter', () => {
  it('doubles with each attempt', () => {
    // random() = 0.5 makes the jitter factor exactly 1, so the base curve is visible.
    const at = (attempts: number) => nextRetryDelayMs({ attempts, random: () => 0.5 });
    expect(at(0)).toBe(1_000);
    expect(at(1)).toBe(2_000);
    expect(at(2)).toBe(4_000);
    expect(at(5)).toBe(32_000);
  });

  it('caps at fifteen minutes', () => {
    expect(nextRetryDelayMs({ attempts: 40, random: () => 0.5 })).toBe(15 * 60 * 1_000);
    expect(nextRetryDelayMs({ attempts: 40, random: () => 0.999 })).toBeLessThanOrEqual(
      Math.round(15 * 60 * 1_000 * 1.499),
    );
  });

  it('spreads the delay across random(0.5, 1.5) of the base', () => {
    // The point of full jitter: a plant's devices regain signal together when the shift
    // changes, and a deterministic schedule would have all of them retry in one second.
    expect(nextRetryDelayMs({ attempts: 3, random: () => 0 })).toBe(4_000);
    expect(nextRetryDelayMs({ attempts: 3, random: () => 1 })).toBe(12_000);

    const spread = new Set(
      Array.from({ length: 200 }, () => nextRetryDelayMs({ attempts: 6 })),
    );
    expect(spread.size).toBeGreaterThan(50);
  });

  it('honours Retry-After over its own arithmetic', () => {
    // A 429 with a stated wait is the server telling the device the answer. Computing a
    // different one is guessing over knowledge.
    expect(nextRetryDelayMs({ attempts: 1, status: 429, retryAfterMs: 45_000 })).toBe(45_000);
  });

  it('still caps a Retry-After the server sends in hours', () => {
    expect(nextRetryDelayMs({ attempts: 1, retryAfterMs: 6 * 60 * 60 * 1_000 })).toBe(
      15 * 60 * 1_000,
    );
  });
});

/** §9.5's clock-skew normalization. */
describe('clock skew', () => {
  it('produces a negative offset for a device running fast', () => {
    const offset = serverTimeOffsetMs('2026-09-09T10:05:00.000Z', '2026-09-09T10:00:00.000Z');
    expect(offset).toBe(-300_000);
    expect(normalizeToServerTime('2026-09-09T10:05:30.000Z', offset)).toBe(
      '2026-09-09T10:00:30.000Z',
    );
  });

  it('produces a positive offset for a device running slow', () => {
    const offset = serverTimeOffsetMs('2026-09-09T09:58:00.000Z', '2026-09-09T10:00:00.000Z');
    expect(offset).toBe(120_000);
    expect(normalizeToServerTime('2026-09-09T09:58:10.000Z', offset)).toBe(
      '2026-09-09T10:00:10.000Z',
    );
  });

  it('is a no-op on a device whose clock agrees', () => {
    const offset = serverTimeOffsetMs('2026-09-09T10:00:00.000Z', '2026-09-09T10:00:00.000Z');
    expect(offset).toBe(0);
    expect(normalizeToServerTime('2026-09-09T11:22:33.000Z', offset)).toBe(
      '2026-09-09T11:22:33.000Z',
    );
  });
});

/** §9.6's crash-recovery sweep: a SYNCING row older than ten minutes is retried. */
describe('stale SYNCING detection', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z');

  it('leaves a transfer that could still be in flight alone', () => {
    expect(STALE_SYNCING_MS).toBe(10 * 60 * 1_000);
    expect(isStaleSyncing('2026-09-09T11:55:00.000Z', now)).toBe(false);
  });

  it('resets one older than the window', () => {
    expect(isStaleSyncing('2026-09-09T11:40:00.000Z', now)).toBe(true);
  });

  it('treats a SYNCING row with no start time as stale', () => {
    // Otherwise it sticks forever — and a stuck item blocks logout (§9.7) with something
    // that will never retry, which is the worst of both.
    expect(isStaleSyncing(null, now)).toBe(true);
  });
});
