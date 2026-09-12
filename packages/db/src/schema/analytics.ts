import { date, index, integer, numeric, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sSectionEnum } from './enums';
import { units } from './identity';
import { zones } from './zones';

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const metricDailyUnits = pgTable(
  'metric_daily_unit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    unitId: uuid('unit_id').notNull().references(() => units.id, { onDelete: 'restrict' }),
    day: date('day', { mode: 'string' }).notNull(),
    auditCount: integer('audit_count').notNull().default(0),
    completedCount: integer('completed_count').notNull().default(0),
    rawScore: integer('raw_score').notNull().default(0),
    maxScore: integer('max_score').notNull().default(0),
    avgScore: numeric('avg_score', { precision: 6, scale: 3 }),
    scoreSampleCount: integer('score_sample_count').notNull().default(0),
    openNc: integer('open_nc').notNull().default(0),
    closedNc: integer('closed_nc').notNull().default(0),
    avgClosureHours: numeric('avg_closure_hours', { precision: 12, scale: 3 }),
    activeAuditors: integer('active_auditors').notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('metric_daily_unit_key').on(table.unitId, table.day),
    index('metric_daily_unit_unit_day_idx').on(table.unitId, table.day),
  ],
);

export const metricDailyZones = pgTable(
  'metric_daily_zone',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    unitId: uuid('unit_id').notNull().references(() => units.id, { onDelete: 'restrict' }),
    zoneId: uuid('zone_id').notNull().references(() => zones.id, { onDelete: 'restrict' }),
    day: date('day', { mode: 'string' }).notNull(),
    auditCount: integer('audit_count').notNull().default(0),
    rawScore: integer('raw_score').notNull().default(0),
    maxScore: integer('max_score').notNull().default(0),
    lastScore: numeric('last_score', { precision: 6, scale: 3 }),
    avgScore: numeric('avg_score', { precision: 6, scale: 3 }),
    scoreSampleCount: integer('score_sample_count').notNull().default(0),
    openNc: integer('open_nc').notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('metric_daily_zone_key').on(table.zoneId, table.day),
    index('metric_daily_zone_zone_day_idx').on(table.zoneId, table.day),
    index('metric_daily_zone_unit_day_idx').on(table.unitId, table.day),
  ],
);

export const metricSectionDaily = pgTable(
  'metric_section_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    unitId: uuid('unit_id').notNull().references(() => units.id, { onDelete: 'restrict' }),
    zoneId: uuid('zone_id').notNull().references(() => zones.id, { onDelete: 'restrict' }),
    section: sSectionEnum('section').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    rawScore: integer('raw_score').notNull().default(0),
    maxScore: integer('max_score').notNull().default(0),
    avgScorePercentage: numeric('avg_score_percentage', { precision: 6, scale: 3 }),
    sampleCount: integer('sample_count').notNull().default(0),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex('metric_section_daily_key').on(table.unitId, table.zoneId, table.section, table.day),
    index('metric_section_daily_unit_day_idx').on(table.unitId, table.day),
    index('metric_section_daily_zone_day_idx').on(table.zoneId, table.day),
  ],
);
