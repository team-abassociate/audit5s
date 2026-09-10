import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
