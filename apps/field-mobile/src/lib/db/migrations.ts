/**
 * Forward-only local migrations, keyed on SQLite's own `user_version` (§9.1).
 *
 * Forward-only because a device that has been in a plant for a month holds the only copy
 * of its unsynced work: there is no "roll the schema back" that does not risk it. Each
 * step is additive and idempotent, and the DDL is written out rather than generated so it
 * matches §9.1 exactly and a future step can be read against it.
 */
export interface LocalMigration {
  version: number;
  statements: string[];
}

export const LOCAL_MIGRATIONS: LocalMigration[] = [
  {
    // Phase 2: the cached reference data the questionnaire will read offline.
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS unit (
         id TEXT PRIMARY KEY, code TEXT, name TEXT, latitude REAL, longitude REAL,
         geofence_radius_m INTEGER, timezone TEXT, photo_cap_per_zone INTEGER,
         synced_at TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS zone (
         id TEXT PRIMARY KEY, unit_id TEXT, code TEXT, name TEXT, description TEXT,
         zone_leader_id TEXT, zone_leader_name TEXT, default_checklist_template_id TEXT,
         sort_order INTEGER, archived INTEGER DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS idx_zone_unit ON zone (unit_id, archived, sort_order)`,
      `CREATE TABLE IF NOT EXISTS checklist_version (
         id TEXT PRIMARY KEY, template_id TEXT, template_name TEXT, version_number INTEGER,
         total_questions INTEGER, status TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS checklist_question (
         id TEXT PRIMARY KEY, version_id TEXT, section TEXT, order_in_section INTEGER,
         global_order INTEGER, text TEXT, guidance TEXT, allows_na INTEGER
       )`,
      `CREATE INDEX IF NOT EXISTS idx_question_version
         ON checklist_question (version_id, global_order)`,
      `CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT)`,
    ],
  },
  {
    /*
     * Phase 3: the locally authored tables of §9.1, and the outbox.
     *
     * These are the ones that make forward-only a rule rather than a preference. A device
     * in a plant holds the **only** copy of its unsynced work; there is no rollback of
     * this step that does not risk it, so every statement is additive and idempotent.
     *
     * `sync_state` defaults to `LOCAL_ONLY` on all three: a row exists on the device the
     * instant the auditor taps, and becomes the server's business later. That ordering is
     * §9.1's whole claim — a save is complete when SQLite commits.
     */
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS audit (
         id TEXT PRIMARY KEY, assignment_id TEXT, unit_id TEXT NOT NULL,
         audit_type TEXT NOT NULL, status TEXT NOT NULL, checklist_version_id TEXT,
         selfie_evidence_id TEXT, started_at TEXT, completed_at TEXT,
         paused_at TEXT, pause_reason TEXT, resume_audit_zone_id TEXT,
         start_latitude REAL, start_longitude REAL, start_accuracy_m REAL,
         start_location_provider TEXT, start_location_is_mocked INTEGER,
         client_created_at TEXT NOT NULL, client_updated_at TEXT NOT NULL,
         sync_state TEXT NOT NULL DEFAULT 'LOCAL_ONLY'
       )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_status ON audit (status, client_updated_at)`,

      `CREATE TABLE IF NOT EXISTS audit_zone (
         id TEXT PRIMARY KEY, audit_id TEXT NOT NULL, zone_id TEXT NOT NULL,
         sequence_no INTEGER NOT NULL, status TEXT NOT NULL,
         zone_code_snapshot TEXT NOT NULL, zone_name_snapshot TEXT NOT NULL,
         zone_description_snapshot TEXT,
         zone_leader_user_id_snapshot TEXT, zone_leader_name_snapshot TEXT,
         checklist_version_id TEXT, checklist_template_name_snapshot TEXT,
         zone_remark TEXT, resume_question_id TEXT,
         started_at TEXT, completed_at TEXT, client_updated_at TEXT NOT NULL,
         sync_state TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
         UNIQUE (audit_id, zone_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_zone_audit ON audit_zone (audit_id, sequence_no)`,

      /*
       * `UNIQUE (audit_zone_id, checklist_question_id)` mirrors the server's index of the
       * same shape. It is the idempotency backbone on both sides: re-answering a question
       * updates one row here and updates one row there, so a replayed outbox item cannot
       * turn one answer into two.
       */
      `CREATE TABLE IF NOT EXISTS question_response (
         id TEXT PRIMARY KEY, audit_zone_id TEXT NOT NULL, audit_id TEXT NOT NULL,
         checklist_question_id TEXT NOT NULL, section TEXT NOT NULL,
         global_order INTEGER NOT NULL, value TEXT NOT NULL, numeric_score INTEGER,
         remark TEXT, answered_at TEXT NOT NULL, client_updated_at TEXT NOT NULL,
         sync_state TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
         UNIQUE (audit_zone_id, checklist_question_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_response_zone
         ON question_response (audit_zone_id, global_order)`,

      /*
       * The outbox (§9.1). `UNIQUE (entity_type, entity_id, operation)` is the coalescing
       * rule: a second save of the same row replaces the pending item rather than queueing
       * a second one, so an auditor who changes an answer four times syncs once.
       */
      `CREATE TABLE IF NOT EXISTS outbox (
         id TEXT PRIMARY KEY,
         entity_type TEXT NOT NULL,
         entity_id TEXT NOT NULL,
         operation TEXT NOT NULL,
         payload TEXT NOT NULL,
         queue TEXT NOT NULL DEFAULT 'data',
         priority INTEGER NOT NULL DEFAULT 100,
         attempts INTEGER NOT NULL DEFAULT 0,
         next_attempt_at TEXT,
         last_error TEXT,
         state TEXT NOT NULL DEFAULT 'PENDING',
         created_at TEXT NOT NULL,
         UNIQUE (entity_type, entity_id, operation)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_ready
         ON outbox (queue, state, next_attempt_at, priority, created_at)`,
    ],
  },
  {
    /*
     * Phase 4: `evidence`, and the columns the media queue needs.
     *
     * Forward-only matters most here. A device in a plant holds the only copy of its
     * unsynced photographs *and* the only copy of the files they point at — there is no
     * rollback of this step that does not risk both, so every statement is additive and
     * idempotent, and `ALTER TABLE ... ADD COLUMN` is used rather than a table rebuild.
     */
    version: 3,
    statements: [
      /*
       * The evidence row of §9.1. It exists from the instant the shutter closes: the
       * photograph is on the device and in SQLite before any of it is the server's
       * business, which is the same ordering every other locally authored table follows.
       *
       * `upload_attempts` is here rather than on the outbox because §9.1 puts it here, and
       * because it survives the outbox row being deleted on success — a photo that took
       * six attempts is worth knowing about when a support call asks why a Zone was slow.
       */
      `CREATE TABLE IF NOT EXISTS evidence (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         audit_id TEXT NOT NULL,
         audit_zone_id TEXT,
         question_response_id TEXT,
         local_file_uri TEXT,
         object_key TEXT,
         content_type TEXT NOT NULL DEFAULT 'image/jpeg',
         byte_size INTEGER NOT NULL DEFAULT 0,
         width INTEGER,
         height INTEGER,
         checksum_sha256 TEXT NOT NULL,
         score_at_capture TEXT,
         classification TEXT NOT NULL DEFAULT 'NEUTRAL',
         remark TEXT,
         is_summary_flagged INTEGER NOT NULL DEFAULT 0,
         is_live_capture INTEGER NOT NULL DEFAULT 1,
         latitude REAL, longitude REAL, accuracy_m REAL,
         location_provider TEXT,
         captured_at TEXT NOT NULL,
         uploaded_at TEXT,
         deleted_at TEXT,
         client_updated_at TEXT NOT NULL,
         sync_state TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
         upload_attempts INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS idx_evidence_zone
         ON evidence (audit_zone_id, deleted_at, captured_at)`,
      `CREATE INDEX IF NOT EXISTS idx_evidence_audit ON evidence (audit_id, kind)`,
      /* The media queue's own hot path: what still has to go up. */
      `CREATE INDEX IF NOT EXISTS idx_evidence_pending
         ON evidence (sync_state, upload_attempts) WHERE deleted_at IS NULL`,

      /*
       * §9.6: "Outbox row is `SYNCING` with a `started_at`. On start, any `SYNCING` older
       * than 10 min is reset to `PENDING`." Phase 3's outbox had no `started_at`, so a
       * row that went SYNCING and then lost the process stayed SYNCING forever — and a
       * stuck row blocks logout (§9.7) with something that will never retry.
       */
      `ALTER TABLE outbox ADD COLUMN started_at TEXT`,
      /* Which batch carried it, so a device can match the server's verdicts to its rows. */
      `ALTER TABLE outbox ADD COLUMN batch_id TEXT`,
    ],
  },
];

export const LOCAL_SCHEMA_VERSION = LOCAL_MIGRATIONS[LOCAL_MIGRATIONS.length - 1]!.version;
