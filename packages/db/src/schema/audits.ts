import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { checklistQuestions, checklistVersions } from './checklists';
import {
  assignmentStatusEnum,
  auditStatusEnum,
  auditTypeEnum,
  auditZoneStatusEnum,
  locationProviderEnum,
  responseValueEnum,
  sSectionEnum,
  syncStateEnum,
} from './enums';
import { devices } from './access';
import { units, users } from './identity';
import { zones } from './zones';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * The audit engine (ARCHITECTURE.md §5.5).
 *
 * Invariants A-1, A-2 and QR-1 live in migration 0006 as triggers and a CHECK. They are
 * deliberately not expressible here: an ORM-level rule is advice, and each of these
 * protects data that cannot be reconstructed once it is wrong.
 *
 * Note what is *not* a Drizzle default on `audit`, `auditZone` and `questionResponse`:
 * the primary key. Those ids are the device's UUIDv7 (D12), so a row the server keyed for
 * itself could never be reconciled with the device row that authored it.
 */

export const auditAssignments = pgTable(
  'audit_assignment',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    auditorUserId: uuid('auditor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    auditType: auditTypeEnum('audit_type').notNull(),
    status: assignmentStatusEnum('status').notNull().default('ASSIGNED'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    instructions: text('instructions'),
    /** Hints for the Zone picker; the auditor may choose others (§5.5). */
    suggestedZoneIds: uuid('suggested_zone_ids').array(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    ...timestamps,
  },
  (table) => [
    index('audit_assignment_auditor_idx').on(table.auditorUserId, table.status, table.dueAt),
    index('audit_assignment_unit_idx').on(table.unitId, table.status),
    index('audit_assignment_due_idx').on(table.status, table.dueAt),
  ],
);

export const audits = pgTable(
  'audit',
  {
    /** Client-generated UUIDv7 (D12). No default, by design. */
    id: uuid('id').primaryKey(),
    assignmentId: uuid('assignment_id').references(() => auditAssignments.id, {
      onDelete: 'restrict',
    }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    auditType: auditTypeEnum('audit_type').notNull(),
    status: auditStatusEnum('status').notNull().default('READY'),
    auditorUserId: uuid('auditor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The single-writer lock (D7). */
    owningDeviceId: uuid('owning_device_id').references(() => devices.id, { onDelete: 'restrict' }),
    checklistVersionId: uuid('checklist_version_id').references(() => checklistVersions.id, {
      onDelete: 'restrict',
    }),
    /** The FK arrives with `evidence`; the column ships with the lifecycle that writes it. */
    selfieEvidenceId: uuid('selfie_evidence_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    startLatitude: numeric('start_latitude', { precision: 9, scale: 6 }),
    startLongitude: numeric('start_longitude', { precision: 9, scale: 6 }),
    startAccuracyM: numeric('start_accuracy_m', { precision: 8, scale: 2 }),
    startLocationProvider: locationProviderEnum('start_location_provider'),
    /** Advisory only; never blocks (CH-4). */
    startLocationIsMocked: boolean('start_location_is_mocked'),
    startDistanceFromUnitM: numeric('start_distance_from_unit_m', { precision: 10, scale: 2 }),
    locationSuspicious: boolean('location_suspicious').notNull().default(false),
    /** Cache. Recomputable from `question_response`, which is what keeps D5 checkable. */
    totalScore: numeric('total_score', { precision: 6, scale: 3 }),
    applicableQuestions: integer('applicable_questions'),
    naQuestions: integer('na_questions'),
    rawScore: integer('raw_score'),
    maxScore: integer('max_score'),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pauseReason: text('pause_reason'),
    resumeAuditZoneId: uuid('resume_audit_zone_id'),
    /** Device clock — conflict ordering only, never a business date. */
    clientCreatedAt: timestamp('client_created_at', { withTimezone: true }).notNull().defaultNow(),
    clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }).notNull().defaultNow(),
    serverReceivedAt: timestamp('server_received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index('audit_unit_status_idx').on(table.unitId, table.status, table.completedAt),
    index('audit_auditor_idx').on(table.auditorUserId, table.completedAt),
    index('audit_unit_type_idx').on(table.unitId, table.auditType, table.completedAt),
    index('audit_status_idx').on(table.status),
    index('audit_suspicious_idx').on(table.locationSuspicious),
    index('audit_owning_device_idx').on(table.owningDeviceId),

    // §5.5: "`checklist_version_id` — Null for `WALK_BY`." §2.7 opens "No questionnaire,
    // no score", and this is the half of it a constraint can express. The other half —
    // that a walk-by *Zone* pins nothing either — is a trigger in 0008, because
    // `audit_zone` does not carry the audit type.
    check(
      'audit_walk_by_has_no_checklist',
      sql`audit_type <> 'WALK_BY' OR checklist_version_id IS NULL`,
    ),
  ],
);

/**
 * The D6 snapshots are the six `*_snapshot` columns. Everything a report prints about a
 * Zone comes from them; `zoneId` is a live pointer kept for trend analytics alone.
 */
export const auditZones = pgTable(
  'audit_zone',
  {
    id: uuid('id').primaryKey(),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'restrict' }),
    zoneId: uuid('zone_id')
      .notNull()
      .references(() => zones.id, { onDelete: 'restrict' }),
    sequenceNo: integer('sequence_no').notNull(),
    status: auditZoneStatusEnum('status').notNull().default('DRAFT'),

    zoneCodeSnapshot: text('zone_code_snapshot').notNull(),
    zoneNameSnapshot: text('zone_name_snapshot').notNull(),
    /** What the report renders. Editing the live Zone afterwards does not touch it (D6). */
    zoneDescriptionSnapshot: text('zone_description_snapshot'),
    zoneLeaderUserIdSnapshot: uuid('zone_leader_user_id_snapshot').references(() => users.id, {
      onDelete: 'restrict',
    }),
    zoneLeaderNameSnapshot: text('zone_leader_name_snapshot'),

    /** The binding version for this Zone's questions (QR-2). */
    checklistVersionId: uuid('checklist_version_id').references(() => checklistVersions.id, {
      onDelete: 'restrict',
    }),
    checklistTemplateNameSnapshot: text('checklist_template_name_snapshot'),

    zoneRemark: text('zone_remark'),
    /** Null when every question is NA (D4). */
    scorePercentage: numeric('score_percentage', { precision: 6, scale: 3 }),
    applicableQuestions: integer('applicable_questions').notNull().default(0),
    naQuestions: integer('na_questions').notNull().default(0),
    rawScore: integer('raw_score').notNull().default(0),
    maxScore: integer('max_score').notNull().default(0),

    /**
     * R-29's lock, derived from `audit.status` and written only by 0021's triggers.
     *
     * A Zone is claimed while the audit holding it is open, so a second audit of the same
     * Unit cannot take it. Listed here because Drizzle selects the table's columns by
     * name; nothing in the application ever sets it.
     */
    auditOpen: boolean('audit_open').notNull().default(true),

    resumeQuestionId: uuid('resume_question_id').references(() => checklistQuestions.id, {
      onDelete: 'restrict',
    }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('audit_zone_audit_zone_key').on(table.auditId, table.zoneId),
    uniqueIndex('audit_zone_sequence_key').on(table.auditId, table.sequenceNo),
    index('audit_zone_zone_completed_idx').on(table.zoneId, table.completedAt),
    index('audit_zone_audit_status_idx').on(table.auditId, table.status),
    // R-29. Partial, so a Zone is unique only among the audits still holding it.
    uniqueIndex('audit_zone_claimed_by_open_audit')
      .on(table.zoneId)
      .where(sql`audit_open`),
  ],
);

/**
 * Materialised per-S scores, written on Zone completion.
 *
 * Denormalised on purpose (§5.5): the radar chart and the S-trend query are the two most
 * frequent analytics reads, and rebuilding them from fifty rows per Zone per request is
 * waste. They are derived from the same pure function the device ran, never re-derived by
 * a second implementation.
 */
export const auditZoneSectionScores = pgTable(
  'audit_zone_section_score',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    auditZoneId: uuid('audit_zone_id')
      .notNull()
      .references(() => auditZones.id, { onDelete: 'restrict' }),
    section: sSectionEnum('section').notNull(),
    applicableQuestions: integer('applicable_questions').notNull(),
    naQuestions: integer('na_questions').notNull(),
    rawScore: integer('raw_score').notNull(),
    maxScore: integer('max_score').notNull(),
    scorePercentage: numeric('score_percentage', { precision: 6, scale: 3 }),
    ...timestamps,
  },
  (table) => [uniqueIndex('audit_zone_section_score_key').on(table.auditZoneId, table.section)],
);

export const questionResponses = pgTable(
  'question_response',
  {
    id: uuid('id').primaryKey(),
    auditZoneId: uuid('audit_zone_id')
      .notNull()
      .references(() => auditZones.id, { onDelete: 'restrict' }),
    /** Denormalised from the parent: the audit-wide roll-up becomes one index scan. */
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'restrict' }),
    checklistQuestionId: uuid('checklist_question_id')
      .notNull()
      .references(() => checklistQuestions.id, { onDelete: 'restrict' }),
    /** Denormalised from the question: makes S-wise aggregation index-only. */
    section: sSectionEnum('section').notNull(),
    globalOrder: integer('global_order').notNull(),
    value: responseValueEnum('value').notNull(),
    /** Null iff `value` is NA — QR-1, a CHECK constraint in 0006. */
    numericScore: smallint('numeric_score'),
    remark: text('remark'),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull(),
    clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true }).notNull().defaultNow(),
    syncState: syncStateEnum('sync_state').notNull().default('SYNCED'),
    ...timestamps,
  },
  (table) => [
    // The idempotency backbone: a retried sync can only ever update the same row.
    uniqueIndex('question_response_zone_question_key').on(
      table.auditZoneId,
      table.checklistQuestionId,
    ),
    index('question_response_audit_idx').on(table.auditId),
    index('question_response_zone_order_idx').on(table.auditZoneId, table.globalOrder),
    index('question_response_question_value_idx').on(table.checklistQuestionId, table.value),
  ],
);
