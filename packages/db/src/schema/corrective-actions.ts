import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { audits, auditZones } from './audits';
import { checklistQuestions } from './checklists';
import { correctiveActionStatusEnum, correctiveOptionEnum } from './enums';
import { evidence } from './evidence';
import { units, users } from './identity';
import { zones } from './zones';

/**
 * Corrective actions (ARCHITECTURE.md §5.7).
 *
 * CA-1 and CA-2, the one-action-per-photo index and the no-delete triggers live in
 * migration 0009. The indexes below are declared so a reader sees them beside the columns;
 * they are enforced because the database holds them.
 */
export const correctiveActions = pgTable(
  'corrective_action',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    evidenceId: uuid('evidence_id')
      .notNull()
      .references(() => evidence.id, { onDelete: 'restrict' }),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'restrict' }),
    auditZoneId: uuid('audit_zone_id')
      .notNull()
      .references(() => auditZones.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    zoneId: uuid('zone_id')
      .notNull()
      .references(() => zones.id, { onDelete: 'restrict' }),
    checklistQuestionId: uuid('checklist_question_id').references(() => checklistQuestions.id, {
      onDelete: 'restrict',
    }),
    status: correctiveActionStatusEnum('status').notNull().default('OPEN'),
    assignedZoneLeaderUserId: uuid('assigned_zone_leader_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    lastSubmittedAt: timestamp('last_submitted_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    verifiedByUserId: uuid('verified_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    reopenCount: integer('reopen_count').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('corrective_action_evidence_key').on(table.evidenceId),
    index('corrective_action_unit_status_idx').on(table.unitId, table.status),
    index('corrective_action_audit_status_idx').on(table.auditId, table.status),
  ],
);

/** CA-1: append-only. The four review columns change once, and nothing else ever does. */
export const correctiveActionSubmissions = pgTable(
  'corrective_action_submission',
  {
    id: uuid('id').primaryKey(),
    correctiveActionId: uuid('corrective_action_id')
      .notNull()
      .references(() => correctiveActions.id, { onDelete: 'restrict' }),
    attemptNo: integer('attempt_no').notNull(),
    option: correctiveOptionEnum('option').notNull(),
    submittedByUserId: uuid('submitted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    submittedByName: text('submitted_by_name').notNull(),
    description: text('description'),
    explanation: text('explanation'),
    afterEvidenceId: uuid('after_evidence_id').references(() => evidence.id, {
      onDelete: 'restrict',
    }),
    submittedVia: text('submitted_via').notNull(),
    accessTokenId: uuid('access_token_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    reviewOutcome: text('review_outcome'),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewComment: text('review_comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('corrective_action_submission_attempt_key').on(
      table.correctiveActionId,
      table.attemptNo,
    ),
  ],
);
