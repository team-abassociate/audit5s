import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The device's local schema (ARCHITECTURE.md §9.1).
 *
 * Two halves, and the split is the design rather than an accident of ordering.
 *
 * **Cached reference data** — units, zones, checklist versions and questions — is replaced
 * wholesale on each catalogue sync, so none of it carries a `sync_state`: nothing here is
 * ever authored on the device, and a Zone that has been archived must *disappear* rather
 * than linger because no delta mentioned it.
 *
 * **Locally authored data** — audit, audit zone, question response, and the outbox — is
 * the opposite: this device is the only place it exists until a sync succeeds, which is
 * why §9.1 calls SQLite the source of truth while an audit is in progress. Every one of
 * those rows carries a `sync_state`, and the outbox row is written in the *same*
 * transaction as the data it describes.
 *
 * `evidence` and its media queue arrive with the camera work in Phase 4.
 */

export const units = sqliteTable('unit', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  latitude: real('latitude'),
  longitude: real('longitude'),
  geofenceRadiusM: integer('geofence_radius_m'),
  timezone: text('timezone'),
  photoCapPerZone: integer('photo_cap_per_zone'),
  syncedAt: text('synced_at'),
});

export const zones = sqliteTable('zone', {
  id: text('id').primaryKey(),
  unitId: text('unit_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  zoneLeaderId: text('zone_leader_id'),
  /** Denormalised for display: the audit's Zone screen names the leader offline. */
  zoneLeaderName: text('zone_leader_name'),
  defaultChecklistTemplateId: text('default_checklist_template_id'),
  sortOrder: integer('sort_order'),
  archived: integer('archived').notNull().default(0),
});

export const checklistVersions = sqliteTable('checklist_version', {
  id: text('id').primaryKey(),
  templateId: text('template_id').notNull(),
  templateName: text('template_name').notNull(),
  versionNumber: integer('version_number').notNull(),
  totalQuestions: integer('total_questions').notNull(),
  status: text('status').notNull(),
});

export const checklistQuestions = sqliteTable('checklist_question', {
  id: text('id').primaryKey(),
  versionId: text('version_id').notNull(),
  section: text('section').notNull(),
  orderInSection: integer('order_in_section').notNull(),
  globalOrder: integer('global_order').notNull(),
  text: text('text').notNull(),
  guidance: text('guidance'),
  allowsNa: integer('allows_na').notNull().default(1),
});

/** `last_catalogue_sync_at`, `catalogue_version`, `server_time_offset_ms`. */
export const syncMeta = sqliteTable('sync_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const SYNC_META_KEYS = {
  catalogueVersion: 'catalogue_version',
  lastCatalogueSyncAt: 'last_catalogue_sync_at',
  serverTimeOffsetMs: 'server_time_offset_ms',
} as const;

// ---------------------------------------------------------------- locally authored

/**
 * An audit as the device holds it (§9.1).
 *
 * The primary key is a client-generated UUIDv7, the same value the server will store
 * (D12) — which is what makes the eventual push an upsert rather than a reconciliation.
 */
export const audits = sqliteTable('audit', {
  id: text('id').primaryKey(),
  assignmentId: text('assignment_id'),
  unitId: text('unit_id').notNull(),
  auditType: text('audit_type').notNull(),
  status: text('status').notNull(),
  checklistVersionId: text('checklist_version_id'),
  selfieEvidenceId: text('selfie_evidence_id'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  pausedAt: text('paused_at'),
  pauseReason: text('pause_reason'),
  /** Resume cursor at audit level. Resumption is entirely local (§9.8). */
  resumeAuditZoneId: text('resume_audit_zone_id'),
  startLatitude: real('start_latitude'),
  startLongitude: real('start_longitude'),
  startAccuracyM: real('start_accuracy_m'),
  startLocationProvider: text('start_location_provider'),
  startLocationIsMocked: integer('start_location_is_mocked'),
  clientCreatedAt: text('client_created_at').notNull(),
  clientUpdatedAt: text('client_updated_at').notNull(),
  syncState: text('sync_state').notNull().default('LOCAL_ONLY'),
});

/** The D6 snapshots are copied from the cached `zone` row when the Zone is added. */
export const localAuditZones = sqliteTable('audit_zone', {
  id: text('id').primaryKey(),
  auditId: text('audit_id').notNull(),
  zoneId: text('zone_id').notNull(),
  sequenceNo: integer('sequence_no').notNull(),
  status: text('status').notNull(),
  zoneCodeSnapshot: text('zone_code_snapshot').notNull(),
  zoneNameSnapshot: text('zone_name_snapshot').notNull(),
  zoneDescriptionSnapshot: text('zone_description_snapshot'),
  zoneLeaderUserIdSnapshot: text('zone_leader_user_id_snapshot'),
  zoneLeaderNameSnapshot: text('zone_leader_name_snapshot'),
  checklistVersionId: text('checklist_version_id'),
  checklistTemplateNameSnapshot: text('checklist_template_name_snapshot'),
  zoneRemark: text('zone_remark'),
  /** Where the questionnaire reopens (§9.8). */
  resumeQuestionId: text('resume_question_id'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  clientUpdatedAt: text('client_updated_at').notNull(),
  syncState: text('sync_state').notNull().default('LOCAL_ONLY'),
});

export const localQuestionResponses = sqliteTable('question_response', {
  id: text('id').primaryKey(),
  auditZoneId: text('audit_zone_id').notNull(),
  auditId: text('audit_id').notNull(),
  checklistQuestionId: text('checklist_question_id').notNull(),
  section: text('section').notNull(),
  globalOrder: integer('global_order').notNull(),
  value: text('value').notNull(),
  /** Null for NA, exactly as QR-1 requires on the server. */
  numericScore: integer('numeric_score'),
  remark: text('remark'),
  answeredAt: text('answered_at').notNull(),
  clientUpdatedAt: text('client_updated_at').notNull(),
  syncState: text('sync_state').notNull().default('LOCAL_ONLY'),
});

/**
 * The outbox (§9.1).
 *
 * Written in the same SQLite transaction as the data it describes, which is what makes
 * "the app was killed a millisecond later and nothing was lost" true rather than hoped
 * for. The sync engine that drains it arrives in Phase 4; the rows it will drain are
 * enqueued from Phase 3, because retrofitting the enqueue into a device already in a
 * plant means a forced app update.
 */
export const outbox = sqliteTable('outbox', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  operation: text('operation').notNull(),
  /** A JSON snapshot at enqueue time. */
  payload: text('payload').notNull(),
  queue: text('queue').notNull().default('data'),
  priority: integer('priority').notNull().default(100),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: text('next_attempt_at'),
  lastError: text('last_error'),
  state: text('state').notNull().default('PENDING'),
  createdAt: text('created_at').notNull(),
});

/** The operations the outbox carries. `delete` and `submit` join them in later phases. */
export const OUTBOX_OPERATIONS = ['upsert', 'complete', 'pause', 'resume'] as const;
export type OutboxOperation = (typeof OUTBOX_OPERATIONS)[number];
