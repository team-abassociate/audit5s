import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { devices } from './access';
import { users } from './identity';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * `device_sync_record` (ARCHITECTURE.md §5.9) — one row per sync batch.
 *
 * This is operational telemetry, and it is the difference between "the audit never
 * arrived" being unanswerable and being a query: which batch, when, from which device,
 * how many items, and what the server said about each.
 *
 * `batchId` is unique, and that index is load-bearing rather than hygienic: it is what
 * makes a replayed batch return its **stored** verdicts instead of applying twice. §9.3
 * requires that a duplicate `batchId` create no duplicates, and this is the enforcement —
 * not the service's memory of having seen it.
 */
export const deviceSyncRecords = pgTable(
  'device_sync_record',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    direction: text('direction').notNull().default('PUSH'),
    batchId: uuid('batch_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    itemCount: integer('item_count').notNull().default(0),
    acceptedCount: integer('accepted_count').notNull().default(0),
    rejectedCount: integer('rejected_count').notNull().default(0),
    conflictCount: integer('conflict_count').notNull().default(0),
    bytesUploaded: bigint('bytes_uploaded', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('IN_PROGRESS'),
    error: text('error'),
    appVersion: text('app_version'),
    networkType: text('network_type'),
    /** The verdicts, so a replay answers from storage rather than by reapplying. */
    results: jsonb('results'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('device_sync_record_batch_key').on(table.batchId),
    index('device_sync_record_device_idx').on(table.deviceId, table.startedAt),
    index('device_sync_record_user_status_idx').on(table.userId, table.status),
    check('device_sync_record_direction', sql`direction IN ('PUSH','PULL')`),
  ],
);

/**
 * `sync_conflict` (§5.9, §9.5 Layer 3) — quarantine, never silent loss.
 *
 * > Everything lands in `sync_conflict` with the **full incoming payload**. The system has
 * > no code path that drops field data on the floor — that is the single most important
 * > property of this design, because a discarded audit response is unrecoverable and
 * > invisible.
 *
 * `incomingPayload` is `notNull` for exactly that reason. A quarantine row without its
 * payload records that something was lost, which is worse than useless: it is the shape of
 * an audit trail with none of the substance.
 */
export const syncConflicts = pgTable(
  'sync_conflict',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** Nullable: a conflict outlives the device inventory it came from. */
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** Text, not an enum: a diagnostic record, so a sixth reason needs no migration. */
    reason: text('reason').notNull(),
    /** Why the server refused it, in its own words. Null for rows quarantined before 0020. */
    detail: text('detail'),
    incomingPayload: jsonb('incoming_payload').notNull(),
    existingPayload: jsonb('existing_payload'),
    batchId: uuid('batch_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    resolution: text('resolution'),
    resolutionNote: text('resolution_note'),
    ...timestamps,
  },
  (table) => [
    index('sync_conflict_unresolved_idx').on(table.resolvedAt, table.createdAt),
    index('sync_conflict_entity_idx').on(table.entityType, table.entityId),
    index('sync_conflict_user_idx').on(table.userId),
    index('sync_conflict_device_idx').on(table.deviceId, table.createdAt),
    check('sync_conflict_resolution', sql`resolution IS NULL OR resolution IN ('APPLY','DISCARD')`),
    check(
      'sync_conflict_resolved_together',
      sql`(resolved_at IS NULL) = (resolved_by_user_id IS NULL)`,
    ),
  ],
);
