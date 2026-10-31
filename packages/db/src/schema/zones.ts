import { sql } from 'drizzle-orm';
import { date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { checklistTemplates } from './checklists';
import { units, users } from './identity';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * Zones (ARCHITECTURE.md §5.3).
 *
 * `unitId` is immutable (invariant Z-1) and enforced by a trigger in the migration, not
 * only by the absence of the field from the update contract.
 */
export const zones = pgTable(
  'zone',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Freely editable: history is protected by the AuditZone snapshot (D6). */
    description: text('description'),
    departmentHint: text('department_hint'),
    defaultChecklistTemplateId: uuid('default_checklist_template_id').references(
      () => checklistTemplates.id,
      { onDelete: 'restrict' },
    ),
    /** A responsibility pointer, not a permission (C2). */
    zoneLeaderId: uuid('zone_leader_id').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * Free-text leader, for a Zone whose leader has no user account (0015).
     *
     * Display-only, and the account always outranks it: reads coalesce
     * `app_zone_leader_name(unit_id, zone_leader_id)` ahead of this. Written only by
     * `app_set_zone_leader_name()`, from the name an auditor types during an audit —
     * never by an ordinary update, and never joined on.
     */
    zoneLeaderName: text('zone_leader_name'),
    sortOrder: integer('sort_order').notNull().default(0),
    version: integer('version').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('zone_unit_code_key').on(table.unitId, table.code),
    index('zone_unit_active_sort_idx').on(table.unitId, table.archivedAt, table.sortOrder),
    index('zone_leader_idx').on(table.zoneLeaderId),
  ],
);

/**
 * One cross audit a Coordinator called, of one Zone or many (0051, owner 2026-10-14). Its
 * `dueOn` is the deadline in force — the Coordinator may move it — and it ends when every
 * Zone is audited or the Coordinator completes it, with a remark if a Zone was left.
 */
export const crossAuditRounds = pgTable(
  'cross_audit_round',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    calledByUserId: uuid('called_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    calledByLabel: text('called_by_label').notNull(),
    dueOn: date('due_on', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedByUserId: uuid('completed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    completedByLabel: text('completed_by_label'),
    completionRemark: text('completion_remark'),
  },
  (table) => [index('cross_audit_round_unit_idx').on(table.unitId, table.createdAt)],
);

/**
 * A Zone of a called cross audit, with the date first asked (0050). Append-only: whether it
 * is answered is read from the audits of its Zone; the deadline in force is its round's.
 */
export const crossAuditCalls = pgTable(
  'cross_audit_call',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    zoneId: uuid('zone_id')
      .notNull()
      .references(() => zones.id, { onDelete: 'restrict' }),
    calledByUserId: uuid('called_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    calledByLabel: text('called_by_label').notNull(),
    dueOn: date('due_on', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    roundId: uuid('round_id')
      .notNull()
      .references(() => crossAuditRounds.id, { onDelete: 'restrict' }),
  },
  (table) => [
    index('cross_audit_call_unit_idx').on(table.unitId, table.createdAt),
    index('cross_audit_call_round_idx').on(table.roundId),
  ],
);

/**
 * R-73 (0060): who the Coordinator gave a Zone of a called cross audit to. Append-only: a
 * reassignment is a new row, and the latest row for a call is the assignment in force. A
 * call with no row went to every Zone Leader, as calls before 0060 did.
 */
export const crossAuditAssignments = pgTable(
  'cross_audit_assignment',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    callId: uuid('call_id')
      .notNull()
      .references(() => crossAuditCalls.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    auditorUserId: uuid('auditor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assignedByUserId: uuid('assigned_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('cross_audit_assignment_call_idx').on(table.callId, table.createdAt),
    index('cross_audit_assignment_auditor_idx').on(table.auditorUserId),
  ],
);
