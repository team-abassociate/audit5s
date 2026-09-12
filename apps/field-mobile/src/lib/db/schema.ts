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
 * Phase 4 adds `evidence`, which belongs to the second half: a photograph exists on the
 * device before it is the server's business, exactly like an answer.
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
  /** §9.9's "last successful sync", shown relative and absolute on tap. */
  lastSuccessfulPushAt: 'last_successful_push_at',
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
  /** When the current attempt began — §9.6's ten-minute stale-SYNCING reset reads this. */
  startedAt: text('started_at'),
  /** The batch that carried it, so a verdict can be matched back to the row. */
  batchId: text('batch_id'),
});

/**
 * The operations the outbox carries.
 *
 * `delete` and `commit` join in Phase 4 with evidence: a photo removed before completion
 * is a soft delete the server has to hear about, and `commit` is the second half of §9.4's
 * two-phase media flow. `submit` is a corrective-action attempt (Phase 6).
 */
export const OUTBOX_OPERATIONS = [
  'upsert',
  'patch',
  'complete',
  'pause',
  'resume',
  'delete',
  'commit',
  'submit',
] as const;
export type OutboxOperation = (typeof OUTBOX_OPERATIONS)[number];

/** `data` carries small ordered JSON; `media` carries large binary, in parallel (§9.3). */
export const OUTBOX_QUEUES = ['data', 'media'] as const;
export type OutboxQueue = (typeof OUTBOX_QUEUES)[number];

/**
 * The device's evidence rows (§9.1).
 *
 * `syncState` moves `LOCAL_ONLY → PENDING → SYNCING → SYNCED` exactly as §7.4 draws it,
 * and `DEAD_LETTER` is the device-local sixth state the outbox tracks — so the UI can
 * distinguish "retrying" from "needs your attention", which the server enum cannot.
 */
export const localEvidence = sqliteTable('evidence', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  auditId: text('audit_id').notNull(),
  auditZoneId: text('audit_zone_id'),
  questionResponseId: text('question_response_id'),
  /** The file on this device. Retained 7 days after sync for offline report preview. */
  localFileUri: text('local_file_uri'),
  /** Minted by `upload-intent`; null until the device has been online once. */
  objectKey: text('object_key'),
  contentType: text('content_type').notNull().default('image/jpeg'),
  byteSize: integer('byte_size').notNull().default(0),
  width: integer('width'),
  height: integer('height'),
  checksumSha256: text('checksum_sha256').notNull(),
  scoreAtCapture: text('score_at_capture'),
  /** The device's own E-1 result, so the badge is right offline. The server re-derives it. */
  classification: text('classification').notNull().default('NEUTRAL'),
  remark: text('remark'),
  isSummaryFlagged: integer('is_summary_flagged').notNull().default(0),
  /** Set by the capture component only (§12.10). There is no gallery path in these flows. */
  isLiveCapture: integer('is_live_capture').notNull().default(1),
  latitude: real('latitude'),
  longitude: real('longitude'),
  accuracyM: real('accuracy_m'),
  locationProvider: text('location_provider'),
  capturedAt: text('captured_at').notNull(),
  uploadedAt: text('uploaded_at'),
  deletedAt: text('deleted_at'),
  clientUpdatedAt: text('client_updated_at').notNull(),
  syncState: text('sync_state').notNull().default('LOCAL_ONLY'),
  uploadAttempts: integer('upload_attempts').notNull().default(0),
});

// ---------------------------------------------------------------- corrective actions

/**
 * The Zone Leader's open actions, from the catalogue (§8.11) — reference data, replaced
 * wholesale on each sync like the Units and Zones above, so a verified action disappears
 * rather than lingering because no delta mentioned it.
 */
export const localCorrectiveActions = sqliteTable('corrective_action', {
  id: text('id').primaryKey(),
  unitId: text('unit_id').notNull(),
  auditId: text('audit_id').notNull(),
  zoneId: text('zone_id').notNull(),
  zoneCode: text('zone_code').notNull(),
  zoneName: text('zone_name').notNull(),
  status: text('status').notNull(),
  section: text('section'),
  questionGlobalOrder: integer('question_global_order'),
  questionText: text('question_text'),
  findingRemark: text('finding_remark'),
  beforeEvidenceId: text('before_evidence_id').notNull(),
  assignedZoneLeaderUserId: text('assigned_zone_leader_user_id'),
  dueAt: text('due_at'),
  reopenCount: integer('reopen_count').notNull().default(0),
});

/**
 * An attempt this device has made and the server has not yet confirmed (§9.1's locally
 * authored half). It keeps an answered action answered on screen when a catalogue refresh
 * lands before the push, and it is deleted once the server accepts it (R-4).
 */
export const localCorrectiveSubmissions = sqliteTable('corrective_submission', {
  id: text('id').primaryKey(),
  correctiveActionId: text('corrective_action_id').notNull(),
  option: text('option').notNull(),
  /** ACTION_SUBMITTED or NOT_POSSIBLE — what the action becomes when this lands. */
  targetStatus: text('target_status').notNull(),
  afterEvidenceId: text('after_evidence_id'),
  createdAt: text('created_at').notNull(),
});
