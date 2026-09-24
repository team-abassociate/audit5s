import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { LocalDatabase } from './local-database';
import { localEvidence, outbox } from './schema';

/**
 * Every query against the outbox, in one place.
 *
 * The sync engine is about *policy* — which verdict means what, when to retry, what order
 * to send in — and this is the data access underneath it. Keeping them apart is the same
 * split the server makes between a service and a repository, and it has the same two
 * payoffs: the engine is testable against the rules rather than against SQL, and the
 * workspace's `no-restricted-syntax` rule stays on everywhere instead of being switched
 * off for a directory.
 *
 * There is no `ScopeContext` here, and there is nothing for one to do: AZ-1 is a
 * *server* invariant about a multi-tenant database, and a device's SQLite holds exactly
 * one user's work by construction (§9.7 keeps a retained database tagged to its owner and
 * refuses to show it to anybody else).
 */

export type OutboxRow = typeof outbox.$inferSelect;

/** The states that mean "not yet acknowledged by the server" (§9.9). */
export const UNSETTLED_STATES = ['PENDING', 'SYNCING', 'FAILED', 'DEAD_LETTER'] as const;

/**
 * Items whose backoff has elapsed, in queue order.
 *
 * The ordering mirrors §9.1's `idx_outbox_ready` — priority, then age — so the index is
 * the one the query actually uses rather than one that merely exists.
 */
export function readyItems(
  database: LocalDatabase,
  queue: 'data' | 'media',
  nowIso: string,
): Promise<OutboxRow[]> {
  return database
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.queue, queue),
        inArray(outbox.state, ['PENDING', 'FAILED']),
        or(isNull(outbox.nextAttemptAt), lte(outbox.nextAttemptAt, nowIso)),
      ),
    )
    .orderBy(asc(outbox.priority), asc(outbox.createdAt));
}

export function itemsInState(database: LocalDatabase, state: string): Promise<OutboxRow[]> {
  return database.select().from(outbox).where(eq(outbox.state, state));
}

export function unsettledItems(database: LocalDatabase): Promise<OutboxRow[]> {
  return database
    .select()
    .from(outbox)
    .where(inArray(outbox.state, [...UNSETTLED_STATES]));
}

export async function markSyncing(
  database: LocalDatabase,
  outboxId: string,
  startedAtIso: string,
  batchId?: string,
): Promise<void> {
  await database
    .update(outbox)
    .set({
      state: 'SYNCING',
      // The timestamp §9.6's sweep reads. Without it a row that loses its process is stuck
      // SYNCING forever, and a stuck row blocks logout with something that never retries.
      startedAt: startedAtIso,
      ...(batchId ? { batchId } : {}),
    })
    .where(eq(outbox.id, outboxId));
}

export async function markPending(
  database: LocalDatabase,
  outboxId: string,
  lastError?: string | null,
): Promise<void> {
  await database
    .update(outbox)
    .set({
      state: 'PENDING',
      startedAt: null,
      nextAttemptAt: null,
      ...(lastError !== undefined ? { lastError } : {}),
    })
    .where(eq(outbox.id, outboxId));
}

export async function markSettled(
  database: LocalDatabase,
  outboxId: string,
  lastError: string,
): Promise<void> {
  // `SYNCED` rather than deleted: a quarantined item is settled from the device's point of
  // view, and keeping the row with its reason is what lets the UI explain it (§9.3).
  await database
    .update(outbox)
    .set({ state: 'SYNCED', startedAt: null, lastError })
    .where(eq(outbox.id, outboxId));
}

export async function scheduleRetry(
  database: LocalDatabase,
  outboxId: string,
  input: { attempts: number; nextAttemptAtIso: string; lastError: string },
): Promise<void> {
  await database
    .update(outbox)
    .set({
      state: 'FAILED',
      attempts: input.attempts,
      startedAt: null,
      nextAttemptAt: input.nextAttemptAtIso,
      lastError: input.lastError,
    })
    .where(eq(outbox.id, outboxId));
}

/** Never discarded: the row and the file stay, and logout stays blocked (§7.4, §9.7). */
export async function markDeadLetter(
  database: LocalDatabase,
  outboxId: string,
  input: { attempts: number; lastError: string },
): Promise<void> {
  await database
    .update(outbox)
    .set({
      state: 'DEAD_LETTER',
      attempts: input.attempts,
      startedAt: null,
      lastError: input.lastError,
    })
    .where(eq(outbox.id, outboxId));
}

export async function removeItem(database: LocalDatabase, outboxId: string): Promise<void> {
  await database.delete(outbox).where(eq(outbox.id, outboxId));
}

/** §7.4's "manual Sync Now or app upgrade re-enqueue". */
export async function resetDeadLetters(database: LocalDatabase): Promise<number> {
  const rows = await itemsInState(database, 'DEAD_LETTER');
  for (const row of rows) {
    await markPending(database, row.id);
  }
  return rows.length;
}

/**
 * Evidence whose object went up but whose commit never did — §9.6's stranded case.
 *
 * An `objectKey` alone does not mean the object is in storage: it is recorded when
 * `upload-intent` answers, *before* the PUT. So the photograph's own media row has to be
 * gone too — it is removed only after the PUT succeeds — and no commit may be queued
 * already. Reading the key alone queued a commit ahead of every failed PUT, the server
 * refused it as "not in storage yet", and the sweep re-armed the refusal on every cycle.
 */
export function strandedUploads(database: LocalDatabase) {
  return database
    .select()
    .from(localEvidence)
    .where(
      and(
        eq(localEvidence.syncState, 'SYNCING'),
        sql`${localEvidence.objectKey} IS NOT NULL`,
        isNull(localEvidence.deletedAt),
        // Spelled out rather than interpolated: inside a correlated subquery an unqualified
        // column binds to the inner table, and `id` would silently mean the outbox's own.
        sql`NOT EXISTS (
          SELECT 1 FROM outbox AS queued
          WHERE queued.entity_type = 'evidence'
            AND queued.entity_id = evidence.id
            AND queued.operation IN ('upsert', 'commit')
        )`,
      ),
    );
}

/**
 * Commits the old stranded sweep queued ahead of their own upload, and the queue has since
 * refused: the photograph's media row is still waiting, so the commit is premature rather
 * than wrong. Removing it is safe — the media pass queues a fresh one once the PUT lands —
 * and it is what takes these off the "need attention" count on a phone that ran the bug.
 */
export async function removePrematureCommits(database: LocalDatabase): Promise<number> {
  const premature = await database
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(
        eq(outbox.entityType, 'evidence'),
        eq(outbox.operation, 'commit'),
        inArray(outbox.state, ['PENDING', 'FAILED', 'DEAD_LETTER']),
        sql`EXISTS (
          SELECT 1 FROM ${outbox} AS media
          WHERE media.entity_type = 'evidence'
            AND media.entity_id = outbox.entity_id
            AND media.operation = 'upsert'
        )`,
      ),
    );

  for (const row of premature) {
    await removeItem(database, row.id);
  }
  return premature.length;
}

export function evidenceById(database: LocalDatabase, evidenceId: string) {
  return database.select().from(localEvidence).where(eq(localEvidence.id, evidenceId)).limit(1);
}

/** Photographs not yet acknowledged, for §9.9's separate photo count. */
export function unsyncedPhotos(database: LocalDatabase) {
  return database
    .select({ id: localEvidence.id })
    .from(localEvidence)
    .where(and(sql`${localEvidence.syncState} <> 'SYNCED'`, isNull(localEvidence.deletedAt)));
}

/**
 * Audits that still have a photograph on its way up.
 *
 * *Finish audit* can be queued while a photo waits out a retry on a weak connection. Sent
 * first, it froze the audit (A-2) and the photo arriving after it was refused as
 * `AUDIT_ALREADY_COMPLETED` — a 4xx that is never retried, so it dead-lettered, the bar
 * went red, and a nonconformity photo could miss its corrective action. The engine holds
 * such an audit's `complete` back until its photos are up.
 *
 * A dead-lettered photo does not hold it: that one is waiting for a person, and an audit
 * must not be unfinishable because of a single unreadable file.
 */
export async function auditsAwaitingPhotos(database: LocalDatabase): Promise<Set<string>> {
  const rows = await database
    .select({ auditId: localEvidence.auditId })
    .from(outbox)
    .innerJoin(localEvidence, eq(localEvidence.id, outbox.entityId))
    .where(
      and(
        eq(outbox.queue, 'media'),
        inArray(outbox.state, ['PENDING', 'SYNCING', 'FAILED']),
        isNull(localEvidence.deletedAt),
      ),
    );
  return new Set(rows.map((row) => row.auditId));
}
