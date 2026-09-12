import { z } from 'zod';
import { auditAssignmentSchema } from './audit';
import { checklistTemplateSchema, checklistVersionDetailSchema } from './checklist';
import { booleanQuery, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from './common';
import { correctiveActionSchema } from './corrective-action';
import { unitSchema } from './unit';
import { zoneSchema } from './zone';

/**
 * `GET /sync/catalogue` (ARCHITECTURE.md §8.11) — the entire offline bootstrap.
 *
 * Reference data only: the Units the actor may touch, their active Zones, and the
 * published checklist versions with every question. The device replaces its cached copy
 * wholesale, so the payload is complete rather than a delta.
 *
 * Open assignments joined this shape in Phase 3; open corrective actions join it in Phase 6.
 * The envelope is defined once, here, so each is an added field rather than a new endpoint.
 */
export const syncCatalogueSchema = z.object({
  /** Authoritative clock, so a device with a skewed clock can normalise its timestamps. */
  serverTime: isoDateTimeSchema,
  /**
   * Changes when any of the payload does. A device that gets the same value back has
   * nothing to write, which is the cheap path on a slow field connection.
   */
  catalogueVersion: z.string(),
  units: z.array(unitSchema),
  zones: z.array(zoneSchema),
  checklistTemplates: z.array(checklistTemplateSchema),
  checklistVersions: z.array(checklistVersionDetailSchema),
  /**
   * The auditor's open assignments — ASSIGNED, ACCEPTED or IN_PROGRESS. A cancelled one is
   * absent rather than marked, because the device replaces this wholesale: AA-1's
   * `UNIT_ACCESS_REVOKED` case has to make the assignment *disappear* from the tab.
   */
  assignments: z.array(auditAssignmentSchema),
  /**
   * §8.11's "open corrective actions": for a Zone Leader, every action of their Unit not
   * yet VERIFIED — the actionable ones and those awaiting review. Empty for a Consultant,
   * who reads actions but never answers one.
   */
  correctiveActions: z.array(correctiveActionSchema),
});
export type SyncCatalogue = z.infer<typeof syncCatalogueSchema>;

export const syncCatalogueQuerySchema = z.object({
  /**
   * The device's last `catalogueVersion`. When it still matches, the response carries
   * `serverTime` and the same version with empty collections — the device keeps what it has.
   */
  since: z.string().trim().min(1).max(128).optional(),
});
export type SyncCatalogueQuery = z.infer<typeof syncCatalogueQuerySchema>;

// ------------------------------------------------------------------- the push path

/**
 * `POST /sync/batch` (§8.11, §9.3) — the push path.
 *
 * The whole design of this endpoint is in one sentence of §9.3: **per-item results are
 * essential; one malformed row must never block the other 99.** So the response is a list
 * of verdicts, the transport status is 200 whatever happened inside, and every verdict
 * names a device action the table in §9.3 defines.
 */

/**
 * The entity types the batch carries, **in topological order** — a parent always precedes
 * its children. The order is data rather than a comment because both sides sort by it: the
 * device before sending, the server before applying.
 */
export const SYNC_ENTITY_TYPES = [
  'audit',
  'audit_zone',
  'question_response',
  'evidence',
  // After `evidence`: Option A cites an after-photo, whose commit must land first.
  'corrective_action_submission',
] as const;
export const syncEntityTypeSchema = z.enum(SYNC_ENTITY_TYPES);
export type SyncEntityType = z.infer<typeof syncEntityTypeSchema>;

/**
 * `evidence` appears twice in §9.3's ordering — `evidence(metadata)` then
 * `evidence(commit)` — because the object is uploaded between them. The operation carries
 * that distinction, so one entity type is enough.
 *
 * `patch` is the one §9.3 does not name, and Phase 5 needs it for a reason §9.3 could not
 * have: the summary flag and a walk-by's classification are decided *after* the photograph
 * exists. `upsert` cannot carry them — `POST /evidence/upload-intent` is idempotent on the
 * id and returns the existing intent untouched (§8.7), which is exactly what makes a
 * retried upload safe and exactly what makes it unable to change anything. So a flag
 * toggled with the radio off reaches the server as `PATCH /evidence/{id}`, or not at all.
 */
export const SYNC_OPERATIONS = [
  'upsert',
  'complete',
  'pause',
  'resume',
  'delete',
  'commit',
  'patch',
  /** A corrective-action submission (§9.2's trigger list). Inserts one attempt, never two. */
  'submit',
] as const;
export const syncOperationSchema = z.enum(SYNC_OPERATIONS);
export type SyncOperation = z.infer<typeof syncOperationSchema>;

export const syncBatchItemSchema = z.object({
  /** The device's outbox row id. Echoed back verbatim so the device can match verdicts. */
  outboxId: uuidSchema,
  entityType: syncEntityTypeSchema,
  entityId: uuidSchema,
  operation: syncOperationSchema,
  /** The JSON snapshot taken at enqueue time. Validated per (entityType, operation). */
  payload: z.record(z.string(), z.unknown()),
});
export type SyncBatchItem = z.infer<typeof syncBatchItemSchema>;

export const syncBatchRequestSchema = z.object({
  /** Dedupes the **entire** batch: a replayed batchId returns the stored verdicts. */
  batchId: uuidSchema,
  deviceId: uuidSchema,
  appVersion: z.string().trim().max(60).optional(),
  networkType: z.string().trim().max(40).optional(),
  /** The device's clock. The response carries `serverTime` so it can normalise (§9.5). */
  clientTime: isoDateTimeSchema.optional(),
  /** §9.3 batches at most 100 items, so a weak connection retries a small unit of work. */
  items: z.array(syncBatchItemSchema).min(1).max(100),
});
export type SyncBatchRequest = z.infer<typeof syncBatchRequestSchema>;

/**
 * The five verdicts of §9.3, each with a defined device action:
 *
 * | Result | Device action |
 * | --- | --- |
 * | `ACCEPTED` / `DUPLICATE` | mark SYNCED, delete the outbox row |
 * | `RETRY_AFTER_PARENT` | leave PENDING, re-sort, retry next cycle |
 * | `CONFLICT` | mark SYNCED locally — the server has quarantined it, so it is safe |
 * | `REJECTED` | mark FAILED; after max attempts DEAD_LETTER and a visible banner |
 */
export const SYNC_ITEM_STATUSES = [
  'ACCEPTED',
  'DUPLICATE',
  'CONFLICT',
  'RETRY_AFTER_PARENT',
  'REJECTED',
] as const;
export const syncItemStatusSchema = z.enum(SYNC_ITEM_STATUSES);
export type SyncItemStatus = z.infer<typeof syncItemStatusSchema>;

/** The quarantine reasons of §5.9 and §9.5. Stored as text, so this is the wire vocabulary. */
export const SYNC_CONFLICT_REASONS = [
  'AUDIT_ALREADY_COMPLETED',
  'DEVICE_NOT_OWNER',
  'CHECKLIST_VERSION_MISMATCH',
  'SCOPE_REVOKED',
  'VALIDATION_FAILED',
] as const;
export const syncConflictReasonSchema = z.enum(SYNC_CONFLICT_REASONS);
export type SyncConflictReason = z.infer<typeof syncConflictReasonSchema>;

export const syncBatchResultSchema = z.object({
  outboxId: uuidSchema,
  status: syncItemStatusSchema,
  entityId: uuidSchema,
  /** Present on ACCEPTED, so a device can tell a stale echo from a fresh write. */
  serverVersion: z.number().int().optional(),
  reason: syncConflictReasonSchema.optional(),
  /** The `sync_conflict` row this landed in. Present iff the item was quarantined. */
  conflictId: uuidSchema.optional(),
  resolution: z.literal('QUARANTINED').optional(),
  /** `entity_type:id` of the parent the server could not find. */
  missingParent: z.string().optional(),
  errors: z.array(z.string()).optional(),
});
export type SyncBatchResult = z.infer<typeof syncBatchResultSchema>;

export const syncBatchResponseSchema = z.object({
  batchId: uuidSchema,
  /** Authoritative clock: the device stores `server_time_offset_ms` from this (§9.5). */
  serverTime: isoDateTimeSchema,
  /** True when this batchId was already applied and these verdicts are the stored ones. */
  replayed: z.boolean(),
  results: z.array(syncBatchResultSchema),
});
export type SyncBatchResponse = z.infer<typeof syncBatchResponseSchema>;

/**
 * `GET /sync/status` (§8.11) — the server's view of this device.
 *
 * It exists so a field problem is diagnosable from the device rather than only from the
 * admin console: an auditor who has been pushing into a quarantine for two days can see
 * that, and so can the person they phone.
 */
export const syncStatusSchema = z.object({
  deviceId: uuidSchema,
  serverTime: isoDateTimeSchema,
  lastBatchAt: isoDateTimeSchema.nullable(),
  lastBatchStatus: z.string().nullable(),
  /** Audits this device still owns — the D7 lock it has not released. */
  ownedAudits: z.array(
    z.object({
      auditId: uuidSchema,
      status: z.string(),
      unitId: uuidSchema,
      startedAt: isoDateTimeSchema.nullable(),
    }),
  ),
  /** Evidence rows whose object never arrived — §9.4's `orphan_metadata`. */
  awaitingUploadCount: z.number().int().nonnegative(),
  /** Quarantined items from this device that a Super Admin has not resolved yet. */
  unresolvedConflictCount: z.number().int().nonnegative(),
  batchesLast24h: z.number().int().nonnegative(),
});
export type SyncStatus = z.infer<typeof syncStatusSchema>;

// ---------------------------------------------------------- the quarantine, read back

/**
 * A quarantined item (§5.9, §9.5 Layer 3).
 *
 * `incomingPayload` is the **full** payload the device sent. That is the single most
 * important property of the sync design: the system has no code path that drops field data
 * on the floor, so a rejected item is inspectable and, if warranted, applicable.
 */
export const syncConflictSchema = z.object({
  id: uuidSchema,
  deviceId: uuidSchema.nullable(),
  userId: uuidSchema,
  userName: z.string().nullable(),
  entityType: z.string(),
  entityId: uuidSchema,
  reason: syncConflictReasonSchema,
  incomingPayload: z.record(z.string(), z.unknown()),
  existingPayload: z.record(z.string(), z.unknown()).nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  resolvedByUserId: uuidSchema.nullable(),
  resolution: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type SyncConflict = z.infer<typeof syncConflictSchema>;

export const listSyncConflictsQuerySchema = paginationQuerySchema.extend({
  resolved: booleanQuery(false),
  entityType: z.string().trim().max(60).optional(),
  deviceId: uuidSchema.optional(),
});
export type ListSyncConflictsQuery = z.infer<typeof listSyncConflictsQuerySchema>;

/**
 * `POST /sync-conflicts/{id}/resolve` (§8.10).
 *
 * `APPLY` routes through the post-completion override path, so applying quarantined field
 * work is audit-logged with before and after exactly as any other override is. `DISCARD`
 * marks the row resolved and **keeps the payload** — discarding is a decision about what to
 * act on, never about what to retain.
 */
export const resolveSyncConflictRequestSchema = z.object({
  resolution: z.enum(['APPLY', 'DISCARD']),
  note: z.string().trim().min(1).max(2000),
});
export type ResolveSyncConflictRequest = z.infer<typeof resolveSyncConflictRequestSchema>;

/** One row of §5.9's `device_sync_record` — the telemetry the admin console renders. */
export const deviceSyncRecordSchema = z.object({
  id: uuidSchema,
  deviceId: uuidSchema,
  userId: uuidSchema,
  userName: z.string().nullable(),
  direction: z.enum(['PUSH', 'PULL']),
  batchId: uuidSchema,
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  itemCount: z.number().int().nonnegative(),
  acceptedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  bytesUploaded: z.number().int().nonnegative(),
  status: z.string(),
  error: z.string().nullable(),
  appVersion: z.string().nullable(),
  networkType: z.string().nullable(),
});
export type DeviceSyncRecord = z.infer<typeof deviceSyncRecordSchema>;
