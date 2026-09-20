import { SYNC_ENTITY_TYPES, type SyncEntityType, type SyncOperation } from '@audit5s/contracts';

/**
 * The sync engine's two pure rules (ARCHITECTURE.md §9.3): **what order to send in**, and
 * **when to try again**.
 *
 * Both live here rather than in the device because both are also the server's business.
 * The device sorts a batch before sending; the server sorts before applying, so a device
 * with an old build or a torn queue cannot make the server apply a child before its
 * parent. One table, two callers — the same reason `scoreZone` is shared.
 */

// --------------------------------------------------------------------------- ordering

/**
 * `audit → audit_zone → question_response → evidence(metadata) → evidence(commit)` (§9.3).
 *
 * The rank is derived from `SYNC_ENTITY_TYPES`, which is declared in that order, so the
 * contract's list and this table cannot disagree — there is only one list.
 */
const ENTITY_RANK: Record<SyncEntityType, number> = Object.fromEntries(
  SYNC_ENTITY_TYPES.map((entity, index) => [entity, index]),
) as Record<SyncEntityType, number>;

/**
 * The entity order is only half of it, and the missing half is easy to get wrong.
 *
 * `audit → audit_zone → question_response → evidence` orders **creation**: a parent must
 * exist before its children. Completion runs the other way — a Zone is finished after its
 * fifty answers, and an audit after its Zones — so sorting `audit_zone:complete` by entity
 * rank alone would send it ahead of the responses it is waiting for, and the server's
 * `all_questions_answered` guard would refuse a Zone that is in fact complete.
 *
 * So items sort by *phase* first, and only then by entity:
 *
 *   0 `STRUCTURE` — `upsert`, `delete`, `commit`: parent before child, §9.3's order.
 *   1 `LIFECYCLE` — `pause`, `resume`: status moves, in the order the auditor made them.
 *   2 `FINALIZE`  — `complete`: **child before parent**, the reverse of creation.
 *
 * `commit` sits in the structure phase after `upsert` for the other reason §9.3 gives:
 * §9.4's two-phase media flow puts the object upload *between* the metadata row and the
 * commit, so a commit sent alongside its own upsert would arrive before the bytes.
 */
const PHASE = { STRUCTURE: 0, LIFECYCLE: 1, FINALIZE: 2 } as const;

const OPERATION_PHASE: Record<SyncOperation, number> = {
  upsert: PHASE.STRUCTURE,
  delete: PHASE.STRUCTURE,
  commit: PHASE.STRUCTURE,
  patch: PHASE.STRUCTURE,
  // Structure, and last within it by entity rank, so an Option A submission follows the
  // commit of the after-photo it cites.
  submit: PHASE.STRUCTURE,
  pause: PHASE.LIFECYCLE,
  resume: PHASE.LIFECYCLE,
  complete: PHASE.FINALIZE,
  // Last of all (R-30). An override addresses an audit that is already COMPLETED, so
  // anything else in the same batch — the answers, the Zone completions, the audit's own
  // completion — has to land before the correction to them makes sense.
  override: PHASE.FINALIZE,
};

/** Ordering within the structure phase, where two operations touch the same entity. */
const STRUCTURE_OPERATION_RANK: Record<SyncOperation, number> = {
  upsert: 0,
  delete: 1,
  commit: 2,
  // After `commit`, because a flag is only legal once there is a classification to carry
  // it (E-3) and `commit` is where E-1 writes the authoritative one. A patch that arrived
  // first would be refused for a reason the auditor could do nothing about.
  patch: 3,
  submit: 4,
  pause: 0,
  resume: 1,
  complete: 0,
  // After `complete` on the same audit: correcting an audit this batch is also finishing
  // only works in that order.
  override: 1,
};

export interface OrderableSyncItem {
  entityType: SyncEntityType;
  operation: SyncOperation;
  /** Tie-break. The device's outbox `created_at`, so equal ranks keep author order. */
  createdAt?: string;
}

/**
 * Topological order, as a total order over (phase, entity, operation).
 *
 * A real topological sort over the id graph would be stronger and is not needed: the
 * dependency structure here is a fixed four-level hierarchy known at compile time, and a
 * sort over ranks cannot fail to terminate or produce a cycle. What it *cannot* do is
 * order two rows of the same kind whose parents differ — which is precisely why the server
 * validates parent existence and answers `RETRY_AFTER_PARENT` rather than trusting this
 * (§9.3: "so a device with a partially-torn queue self-heals").
 */
export function compareSyncItems(a: OrderableSyncItem, b: OrderableSyncItem): number {
  const phase = OPERATION_PHASE[a.operation] - OPERATION_PHASE[b.operation];
  if (phase !== 0) return phase;

  const entity = ENTITY_RANK[a.entityType] - ENTITY_RANK[b.entityType];
  if (entity !== 0) {
    // Creation descends the hierarchy; completion climbs back up it.
    return OPERATION_PHASE[a.operation] === PHASE.FINALIZE ? -entity : entity;
  }

  const operation =
    STRUCTURE_OPERATION_RANK[a.operation] - STRUCTURE_OPERATION_RANK[b.operation];
  if (operation !== 0) return operation;

  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
}

/** A stable copy in send order. Does not mutate, so a caller may keep its own order. */
export function sortSyncItems<T extends OrderableSyncItem>(items: readonly T[]): T[] {
  return [...items].sort(compareSyncItems);
}

/** §9.3 batches at most 100 items. */
export const MAX_SYNC_BATCH_ITEMS = 100;

// ------------------------------------------------------------------------------ retry

/** §9.3: "Max 8 attempts before `DEAD_LETTER`." */
export const MAX_SYNC_ATTEMPTS = 8;

/** §9.3: `delay = min(2^attempts × 1s, 15min) × random(0.5, 1.5)`. */
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15 * 60 * 1_000;

export interface RetryDecisionInput {
  /** Attempts already made, including the one that just failed. */
  attempts: number;
  /** The HTTP status of the failure, when there was one. */
  status?: number | null;
  /** `Retry-After`, in milliseconds, when the server sent one. */
  retryAfterMs?: number | null;
  /** Injected so the backoff is testable. Defaults to `Math.random`. */
  random?: () => number;
}

export type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; reason: 'DEAD_LETTER' | 'NOT_RETRYABLE' };

/**
 * Whether a failed transport attempt is worth repeating.
 *
 * §9.3: "`4xx` other than `408`/`429` is **not** retried — it is a bug, and retrying it
 * forever hides the bug." That sentence is the whole of this function's opinion: a 422 from
 * a malformed payload will be a 422 on the eighth attempt too, and eight tries per item
 * across a plant's worth of devices turns one client bug into a sustained load with no
 * diagnostic value.
 *
 * A per-*item* `REJECTED` never reaches here at all — the batch returned 200 and the device
 * marks that one item FAILED. This governs the batch call itself.
 */
export function isRetryableStatus(status: number | null | undefined): boolean {
  if (status === null || status === undefined) {
    // A network error, a timeout, a DNS failure: no status at all. Always retryable —
    // this is the normal case in a plant, and it is exactly what backoff is for.
    return true;
  }
  if (status === 408 || status === 429) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

/**
 * The next delay, with **full jitter**.
 *
 * Full jitter (`random(0.5, 1.5)` over the capped exponential) rather than a fixed
 * backoff because the failure mode this protects against is correlated: a plant's devices
 * regain signal together when the shift changes or the gateway comes back, and a
 * deterministic schedule would have all of them retry in the same second, repeatedly.
 *
 * `Retry-After` wins outright when the server sent one — a 429 with a stated wait is the
 * server telling the device the answer, and computing a different one is guessing over
 * knowledge.
 */
export function nextRetryDelayMs(input: RetryDecisionInput): number {
  if (input.retryAfterMs !== null && input.retryAfterMs !== undefined && input.retryAfterMs > 0) {
    return Math.min(input.retryAfterMs, MAX_DELAY_MS);
  }

  const random = input.random ?? Math.random;
  const exponential = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, input.attempts), MAX_DELAY_MS);
  const jitter = 0.5 + random();
  return Math.round(exponential * jitter);
}

/** `nextRetryDelayMs` plus the two reasons not to schedule one at all. */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  if (!isRetryableStatus(input.status)) {
    return { retry: false, reason: 'NOT_RETRYABLE' };
  }
  if (input.attempts >= MAX_SYNC_ATTEMPTS) {
    // DEAD_LETTER, never discarded: the row and its file stay on the device, logout stays
    // blocked, and a `SYNC_FAILURE` is raised (§7.4).
    return { retry: false, reason: 'DEAD_LETTER' };
  }
  return { retry: true, delayMs: nextRetryDelayMs(input) };
}

/**
 * §9.5's clock-skew rule: "the device stores `server_time_offset_ms` and normalizes
 * `client_updated_at` before sending".
 *
 * The offset is *added* to device time to reach server time, so a device running five
 * minutes fast produces a negative offset and its timestamps move back. Business
 * timestamps are server-assigned regardless (§9.5); this only orders events from one
 * device against each other, which is all a device clock is trusted to do.
 */
export function serverTimeOffsetMs(deviceNowIso: string, serverNowIso: string): number {
  return Date.parse(serverNowIso) - Date.parse(deviceNowIso);
}

export function normalizeToServerTime(deviceIso: string, offsetMs: number): string {
  return new Date(Date.parse(deviceIso) + offsetMs).toISOString();
}

/**
 * §9.6: "any `SYNCING` older than 10 min is reset to `PENDING`".
 *
 * The window is generous on purpose. It has to exceed the longest plausible upload on a
 * weak connection, because resetting a transfer that is still in flight wastes the
 * bandwidth that is already scarce — the cost of waiting is a delay, the cost of being
 * too eager is a repeated upload.
 */
export const STALE_SYNCING_MS = 10 * 60 * 1_000;

export function isStaleSyncing(startedAtIso: string | null, nowMs: number): boolean {
  if (!startedAtIso) {
    // SYNCING with no start time cannot be aged, and leaving it stuck forever is the worse
    // failure: it would block logout with an item that never retries.
    return true;
  }
  return nowMs - Date.parse(startedAtIso) > STALE_SYNCING_MS;
}
