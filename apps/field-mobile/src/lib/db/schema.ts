import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The device's local schema (ARCHITECTURE.md §9.1).
 *
 * Only the cached **reference data** exists at Phase 2: the Units the actor may touch,
 * their active Zones, and the published checklist versions with their questions. The
 * locally authored tables — audit, audit_zone, question_response, evidence, outbox —
 * arrive with the audit engine in Phase 3, alongside the code that writes them.
 *
 * Reference data is replaced wholesale on each catalogue sync, so none of it carries a
 * `sync_state`: nothing here is ever authored on the device.
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
