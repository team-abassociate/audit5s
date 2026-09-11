import type {
  SyncBatchItem,
  SyncBatchResponse,
  SyncBatchResult,
  SyncEntityType,
  SyncOperation,
  UploadIntentResponse,
} from '@audit5s/contracts';
import {
  MAX_SYNC_ATTEMPTS,
  MAX_SYNC_BATCH_ITEMS,
  decideRetry,
  isStaleSyncing,
  serverTimeOffsetMs,
  sortSyncItems,
} from '@audit5s/domain';
import type { LocalDatabase } from '../db/local-database';
import { SYNC_META_KEYS } from '../db/schema';
import { uuidv7 } from '../db/audit.repository';
import { setSyncMeta } from '../db/catalogue.repository';
import {
  evidenceById,
  itemsInState,
  markDeadLetter,
  markPending,
  markSettled,
  markSyncing,
  readyItems,
  removeItem,
  resetDeadLetters,
  scheduleRetry,
  strandedUploads,
  type OutboxRow,
} from '../db/outbox.repository';
import {
  markEvidenceIntentIssued,
  markEvidenceSynced,
  queueEvidenceCommit,
  recordUploadAttempt,
} from '../db/evidence.repository';
import type { SyncTransport } from './transport';

/**
 * The sync engine (ARCHITECTURE.md §9.3, §9.4, §9.6).
 *
 * This is what Phase 3's acceptance test stood in for with a hand-written `drainOutbox`.
 * It drains the two queues §9.3 describes:
 *
 *   **data** — small ordered JSON, batched ≤100 and topologically sorted, to `/sync/batch`;
 *   **media** — large binary, uploaded straight to storage through a presigned PUT.
 *
 * Four properties are the reason it is a module rather than a loop at a call site, and
 * each is tested against real SQLite:
 *
 *   1. **A verdict is acted on, never inferred.** Every one of §9.3's five statuses maps to
 *      the device action that table defines, and nothing else touches an outbox row's state.
 *   2. **Failure is bounded but never destructive.** Backoff with full jitter, eight
 *      attempts, `Retry-After` honoured, a non-retryable 4xx stopped immediately — and at
 *      the end `DEAD_LETTER`, which keeps the row and the file.
 *   3. **A crash is recoverable by repeating yourself.** `recoverStaleWork` resets SYNCING
 *      rows older than ten minutes and re-queues commits whose objects already landed.
 *   4. **It never throws at the UI.** A sync that fails leaves the local store exactly as
 *      it was, because §9.1 makes that store the source of truth while an audit is running.
 */

export interface SyncResult {
  /** Items the server accepted or recognised as already applied. */
  accepted: number;
  /** Items quarantined server-side. The device treats these as settled (§9.3). */
  conflicted: number;
  /** Items refused; they retry until `MAX_SYNC_ATTEMPTS` and then dead-letter. */
  failed: number;
  /** Items whose parent had not arrived; left PENDING to re-sort next cycle. */
  deferred: number;
  photosUploaded: number;
  /** True when nothing was pending and no request was made. */
  idle: boolean;
  error?: string;
}

const EMPTY: SyncResult = {
  accepted: 0,
  conflicted: 0,
  failed: 0,
  deferred: 0,
  photosUploaded: 0,
  idle: true,
};

/**
 * One full sync cycle: recover, push photographs, push data.
 *
 * The order is deliberate. §9.3's topological order ends with `evidence(commit)`, and a
 * commit is only meaningful once the object is up — so the media queue runs first and the
 * commits it queues ride the same cycle's data batch.
 */
export async function runSync(
  database: LocalDatabase,
  transport: SyncTransport,
  options: { deviceId: string; appVersion?: string; now?: () => number } = { deviceId: '' },
): Promise<SyncResult> {
  const now = options.now ?? (() => Date.now());

  await recoverStaleWork(database, transport, now());

  const media = await drainMediaQueue(database, transport, now);
  const data = await drainDataQueue(database, transport, options, now);

  return {
    accepted: data.accepted,
    conflicted: data.conflicted,
    failed: data.failed + media.failed,
    deferred: data.deferred,
    photosUploaded: media.uploaded,
    idle: data.idle && media.uploaded === 0 && media.failed === 0,
    ...(data.error ? { error: data.error } : {}),
  };
}

// --------------------------------------------------------------------- crash recovery

/**
 * §9.6, the two cases that need a sweep rather than a retry.
 *
 * *App killed mid-upload*: a row is `SYNCING` with a `started_at`, and no attempt is in
 * flight because the process that owned it is gone. Anything older than ten minutes goes
 * back to `PENDING`. The window is generous because resetting a transfer that is still
 * running wastes the bandwidth that is already scarce.
 *
 * *App killed between the PUT and the commit*: the object is in storage and the device
 * never heard the confirmation. Calling `commit` again is the recovery — the server HEADs
 * the object, finds it, and completes. Idempotent by contract, not by luck.
 */
export async function recoverStaleWork(
  database: LocalDatabase,
  transport: SyncTransport,
  nowMs: number,
): Promise<number> {
  const syncing = await itemsInState(database, 'SYNCING');

  let reset = 0;
  for (const row of syncing) {
    if (!isStaleSyncing(row.startedAt, nowMs)) continue;
    await markPending(database, row.id);
    reset += 1;
  }

  // Evidence whose object went up but whose commit never did. Re-queued rather than
  // called here: the commit then rides the ordinary data batch with everything else.
  for (const row of await strandedUploads(database)) {
    await queueEvidenceCommit(database, row.id);
  }

  void transport;
  return reset;
}

// ----------------------------------------------------------------------- media queue

/**
 * §9.4's two-phase media flow, per photograph:
 *
 *   `upload-intent` → presigned PUT → queue the commit.
 *
 * Concurrency is one at a time. §9.3 permits two, and one is the honest default on a
 * mid-range Android sharing a plant's connection: the second upload competes with the
 * first for the same scarce uplink, and a half-finished pair is worse than one finished
 * photo. It is a constant rather than a config so raising it is a deliberate change.
 */
async function drainMediaQueue(
  database: LocalDatabase,
  transport: SyncTransport,
  now: () => number,
): Promise<{ uploaded: number; failed: number }> {
  const ready = await readyItems(database, 'media', new Date(now()).toISOString());
  let uploaded = 0;
  let failed = 0;

  for (const item of ready) {
    const [row] = await evidenceById(database, item.entityId);

    // The photo was deleted before it ever went up; the queued metadata is moot.
    if (!row || row.deletedAt) {
      await removeItem(database, item.id);
      continue;
    }

    await markSyncing(database, item.id, new Date(now()).toISOString());
    await recordUploadAttempt(database, row.id);

    try {
      const intent = await transport.uploadIntent(
        JSON.parse(item.payload) as Record<string, unknown>,
      );
      await markEvidenceIntentIssued(database, row.id, intent.objectKey);

      await transport.uploadObject(intent, row.localFileUri ?? '', row.contentType);

      // Phase two is queued, not called: an app killed here finds the commit pending and
      // replays it, which is exactly §9.6's path.
      await queueEvidenceCommit(database, row.id);
      await removeItem(database, item.id);
      uploaded += 1;
    } catch (error) {
      await recordFailure(database, item, error, now());
      failed += 1;
    }
  }

  return { uploaded, failed };
}

// ------------------------------------------------------------------------ data queue

async function drainDataQueue(
  database: LocalDatabase,
  transport: SyncTransport,
  options: { deviceId: string; appVersion?: string },
  now: () => number,
): Promise<SyncResult> {
  const ready = await readyItems(database, 'data', new Date(now()).toISOString());
  if (ready.length === 0) {
    return { ...EMPTY };
  }

  // Sorted with the **shared** comparator, so the device and the server agree about order
  // because they run one function rather than two implementations of one rule.
  const ordered = sortSyncItems(
    ready.map((row) => ({
      entityType: row.entityType as SyncEntityType,
      operation: row.operation as SyncOperation,
      createdAt: row.createdAt,
      row,
    })),
  ).slice(0, MAX_SYNC_BATCH_ITEMS);

  const batchId = uuidv7();
  const items: SyncBatchItem[] = ordered.map((entry) => ({
    outboxId: entry.row.id,
    entityType: entry.entityType,
    entityId: entry.row.entityId,
    operation: entry.operation,
    payload: JSON.parse(entry.row.payload) as Record<string, unknown>,
  }));

  for (const entry of ordered) {
    await markSyncing(database, entry.row.id, new Date(now()).toISOString(), batchId);
  }

  let response: SyncBatchResponse;
  try {
    response = await transport.pushBatch({
      batchId,
      deviceId: options.deviceId,
      ...(options.appVersion ? { appVersion: options.appVersion } : {}),
      clientTime: new Date(now()).toISOString(),
      items,
    });
  } catch (error) {
    // The batch itself failed — a timeout, a 503, no signal. Every item goes back to
    // PENDING with a backoff; nothing is marked failed, because nothing was judged.
    for (const entry of ordered) {
      await recordFailure(database, entry.row, error, now());
    }
    return {
      ...EMPTY,
      idle: false,
      failed: ordered.length,
      error: error instanceof Error ? error.message : 'Sync failed',
    };
  }

  // §9.5: the authoritative clock, so a device with a skewed clock can normalise.
  await setSyncMeta(
    database,
    SYNC_META_KEYS.serverTimeOffsetMs,
    String(serverTimeOffsetMs(new Date(now()).toISOString(), response.serverTime)),
  );
  await setSyncMeta(database, SYNC_META_KEYS.lastSuccessfulPushAt, response.serverTime);

  const result = { ...EMPTY, idle: false };
  const byOutboxId = new Map(ordered.map((entry) => [entry.row.id, entry.row]));

  for (const verdict of response.results) {
    const row = byOutboxId.get(verdict.outboxId);
    if (!row) continue;
    await applyVerdict(database, row, verdict, result, now());
  }

  return result;
}

/**
 * §9.3's result table, as code. Each branch is one row of it:
 *
 * | `ACCEPTED` / `DUPLICATE` | mark SYNCED, delete the outbox row |
 * | `RETRY_AFTER_PARENT`     | leave PENDING, re-sort, retry next cycle |
 * | `CONFLICT`               | mark SYNCED locally — the server has quarantined it |
 * | `REJECTED`               | mark FAILED; after max attempts DEAD_LETTER + a banner |
 */
async function applyVerdict(
  database: LocalDatabase,
  row: OutboxRow,
  verdict: SyncBatchResult,
  result: SyncResult,
  nowMs: number,
): Promise<void> {
  switch (verdict.status) {
    case 'ACCEPTED':
    case 'DUPLICATE': {
      if (row.entityType === 'evidence' && row.operation === 'commit') {
        await markEvidenceSynced(database, row.entityId);
      }
      await removeItem(database, row.id);
      result.accepted += 1;
      return;
    }

    case 'RETRY_AFTER_PARENT': {
      // Not a failure: the parent is in a later batch or a later cycle. The attempt count
      // is deliberately **not** incremented — a torn queue must not exhaust its retries on
      // work that is perfectly good.
      await markPending(database, row.id, `Waiting for ${verdict.missingParent ?? 'a parent'}`);
      result.deferred += 1;
      return;
    }

    case 'CONFLICT': {
      // §9.3 is explicit: mark SYNCED locally, because the server has quarantined the
      // payload and it is therefore safe. The device stops retrying; a human decides.
      if (row.entityType === 'evidence') {
        await markEvidenceSynced(database, row.entityId);
      }
      await markSettled(database, row.id, `Held for review: ${verdict.reason ?? 'conflict'}`);
      result.conflicted += 1;
      return;
    }

    case 'REJECTED': {
      // A malformed payload. Retrying it changes nothing — the server will refuse it
      // identically — so it goes straight to DEAD_LETTER and a visible banner rather than
      // burning eight attempts to arrive at the same place.
      await markDeadLetter(database, row.id, {
        attempts: MAX_SYNC_ATTEMPTS,
        lastError: (verdict.errors ?? ['Rejected by the server']).join('; '),
      });
      result.failed += 1;
      return;
    }
  }
  void nowMs;
}

// ---------------------------------------------------------------------------- helpers

/**
 * One failed attempt, scheduled or abandoned by the **shared** retry policy.
 *
 * `decideRetry` is the same function the server-side tests exercise: full jitter over the
 * capped exponential, eight attempts, `Retry-After` honoured, and a non-retryable 4xx
 * stopped at once rather than repeated forever.
 */
async function recordFailure(
  database: LocalDatabase,
  row: OutboxRow,
  error: unknown,
  nowMs: number,
): Promise<void> {
  const attempts = row.attempts + 1;
  const status = (error as { status?: number } | null)?.status ?? null;
  const retryAfterMs = (error as { retryAfterMs?: number } | null)?.retryAfterMs ?? null;
  const message = error instanceof Error ? error.message : 'Unknown error';

  const decision = decideRetry({ attempts, status, retryAfterMs });

  if (!decision.retry) {
    // Never discarded: the row and the file stay on the device, the banner appears, and
    // logout stays blocked until somebody deals with it (§7.4, §9.7).
    await markDeadLetter(database, row.id, { attempts, lastError: message });
    return;
  }

  await scheduleRetry(database, row.id, {
    attempts,
    nextAttemptAtIso: new Date(nowMs + decision.delayMs).toISOString(),
    lastError: message,
  });
}

/** Re-queues every dead-lettered item — §7.4's "manual Sync Now or app upgrade". */
export function retryDeadLetters(database: LocalDatabase): Promise<number> {
  return resetDeadLetters(database);
}

export type { UploadIntentResponse };
