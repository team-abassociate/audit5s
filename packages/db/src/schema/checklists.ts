import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { checklistVersionStatusEnum, importJobStatusEnum, sSectionEnum } from './enums';
import { users } from './identity';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * Checklists (ARCHITECTURE.md §5.4). Organization-wide reference data (D2) — note the
 * absence of a Unit column anywhere in this file.
 *
 * Invariant CV-1 (a published version and its questions are immutable) lives in the
 * migration as a trigger. It is deliberately not expressible here: an ORM-level rule
 * would be advice, and this one has to be a guarantee.
 */
/**
 * Sectors (0018): Engineering, Hospital, Warehouse.
 *
 * A label on reference data, not a tenant. It decides which checklists a screen offers and
 * never who may see what — anything that reads `industryId` to make an access decision is
 * reading it wrong.
 */
export const industries = pgTable(
  'industry',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('industry_code_active_key').on(table.code).where(sql`archived_at IS NULL`),
    index('industry_sort_idx').on(table.sortOrder, table.name),
  ],
);

export const checklistTemplates = pgTable(
  'checklist_template',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** Derived from the workbook sheet name: `Stores (RM)` → `STORES_RM` (R-6a). */
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    /** Which sector offers this template. NULL means every sector (0018). */
    industryId: uuid('industry_id').references(() => industries.id, { onDelete: 'restrict' }),
    /** Workbook order, so the catalogue reads as the business lists its departments. */
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('checklist_template_code_key').on(table.code),
    index('checklist_template_sort_idx').on(table.sortOrder, table.name),
  ],
);

export const checklistImportJobs = pgTable(
  'checklist_import_job',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    uploadedByUserId: uuid('uploaded_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    fileName: text('file_name').notNull(),
    fileObjectKey: text('file_object_key').notNull(),
    fileChecksum: text('file_checksum').notNull(),
    fileByteSize: integer('file_byte_size').notNull(),
    status: importJobStatusEnum('status').notNull().default('UPLOADED'),
    sheetCount: integer('sheet_count').notNull().default(0),
    parsedRowCount: integer('parsed_row_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    warningCount: integer('warning_count').notNull().default(0),
    previewExpiresAt: timestamp('preview_expires_at', { withTimezone: true }),
    errorReportObjectKey: text('error_report_object_key'),
    /** The non-checklist sheets and why they were skipped — the legacy tabs (Q7). */
    skippedSheets: jsonb('skipped_sheets')
      .$type<Array<{ name: string; reason: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...timestamps,
  },
  (table) => [
    index('checklist_import_job_status_idx').on(table.status, table.previewExpiresAt),
    index('checklist_import_job_uploader_idx').on(table.uploadedByUserId, table.createdAt),
  ],
);

export const checklistVersions = pgTable(
  'checklist_version',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    templateId: uuid('template_id')
      .notNull()
      .references(() => checklistTemplates.id, { onDelete: 'restrict' }),
    versionNumber: integer('version_number').notNull(),
    status: checklistVersionStatusEnum('status').notNull().default('DRAFT'),
    /** A1, confirmed against the real workbook. */
    questionsPerSection: integer('questions_per_section').notNull().default(10),
    totalQuestions: integer('total_questions').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedByUserId: uuid('published_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededByVersionId: uuid('superseded_by_version_id'),
    sourceImportJobId: uuid('source_import_job_id').references(() => checklistImportJobs.id, {
      onDelete: 'restrict',
    }),
    /** SHA-256 over the ordered question set — the stage 4 duplicate check. */
    contentHash: text('content_hash').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('checklist_version_template_number_key').on(table.templateId, table.versionNumber),
    // At most one published version per template, at any instant.
    uniqueIndex('checklist_version_one_published')
      .on(table.templateId)
      .where(sql`status = 'PUBLISHED'`),
    uniqueIndex('checklist_version_content_key').on(table.templateId, table.contentHash),
    index('checklist_version_status_idx').on(table.status),
  ],
);

export const checklistQuestions = pgTable(
  'checklist_question',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    versionId: uuid('version_id')
      .notNull()
      .references(() => checklistVersions.id, { onDelete: 'restrict' }),
    section: sSectionEnum('section').notNull(),
    orderInSection: integer('order_in_section').notNull(),
    /** The workbook's `Sr.`; the importer validates that it agrees with the position. */
    globalOrder: integer('global_order').notNull(),
    text: text('text').notNull(),
    guidance: text('guidance'),
    allowsNa: boolean('allows_na').notNull().default(true),
    requiresEvidenceOnNonconformity: boolean('requires_evidence_on_nonconformity')
      .notNull()
      .default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('checklist_question_position_key').on(
      table.versionId,
      table.section,
      table.orderInSection,
    ),
    uniqueIndex('checklist_question_global_key').on(table.versionId, table.globalOrder),
    index('checklist_question_version_order_idx').on(table.versionId, table.globalOrder),
  ],
);

/**
 * One workbook sheet inside an import job.
 *
 * The real file is nine department sheets (R-6a), so a job fans out here and each sheet
 * carries its own duplicate verdict and its own committed version.
 */
export const checklistImportSheets = pgTable(
  'checklist_import_sheet',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    jobId: uuid('job_id')
      .notNull()
      .references(() => checklistImportJobs.id, { onDelete: 'cascade' }),
    sheetName: text('sheet_name').notNull(),
    sheetIndex: integer('sheet_index').notNull(),
    templateCode: text('template_code').notNull(),
    templateName: text('template_name').notNull(),
    /** Null means this sheet would create a new template. */
    templateId: uuid('template_id').references(() => checklistTemplates.id, {
      onDelete: 'restrict',
    }),
    contentHash: text('content_hash').notNull(),
    questionCount: integer('question_count').notNull().default(0),
    severity: text('severity').$type<'OK' | 'WARNING' | 'ERROR'>().notNull().default('OK'),
    duplicateOfVersionId: uuid('duplicate_of_version_id').references(() => checklistVersions.id, {
      onDelete: 'restrict',
    }),
    duplicateIsPublished: boolean('duplicate_is_published').notNull().default(false),
    committedVersionId: uuid('committed_version_id').references(() => checklistVersions.id, {
      onDelete: 'restrict',
    }),
    messages: text('messages').array().notNull().default(sql`ARRAY[]::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('checklist_import_sheet_job_index_key').on(table.jobId, table.sheetIndex),
    index('checklist_import_sheet_job_severity_idx').on(table.jobId, table.severity),
  ],
);

export const checklistImportRows = pgTable(
  'checklist_import_row',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    jobId: uuid('job_id')
      .notNull()
      .references(() => checklistImportJobs.id, { onDelete: 'cascade' }),
    sheetId: uuid('sheet_id')
      .notNull()
      .references(() => checklistImportSheets.id, { onDelete: 'cascade' }),
    sourceRowNumber: integer('source_row_number').notNull(),
    /** The original cells, so the annotated workbook can quote what was actually read. */
    raw: jsonb('raw').notNull(),
    parsedSection: sSectionEnum('parsed_section'),
    parsedOrder: integer('parsed_order'),
    parsedGlobalOrder: integer('parsed_global_order'),
    parsedText: text('parsed_text'),
    severity: text('severity').$type<'OK' | 'WARNING' | 'ERROR'>().notNull(),
    messages: text('messages').array().notNull().default(sql`ARRAY[]::text[]`),
  },
  (table) => [
    index('checklist_import_row_job_severity_idx').on(table.jobId, table.severity),
    index('checklist_import_row_sheet_idx').on(table.sheetId, table.sourceRowNumber),
  ],
);
