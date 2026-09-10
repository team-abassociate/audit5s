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
];

export const LOCAL_SCHEMA_VERSION = LOCAL_MIGRATIONS[LOCAL_MIGRATIONS.length - 1]!.version;
