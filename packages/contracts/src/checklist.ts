import { z } from 'zod';
import {
  checklistVersionStatusSchema,
  importJobStatusSchema,
  sSectionSchema,
} from './enums';
import { isoDateTimeSchema, optional, paginationQuerySchema, uuidSchema } from './common';

/**
 * Checklist templates, versions and questions (ARCHITECTURE.md §5.4), and the six-stage
 * Excel import of §8.5.
 *
 * Checklists are organization-wide reference data (D2): nothing here carries a Unit, which
 * is why PART 6 grants every role read access and why a device may cache the whole
 * catalogue offline.
 */

export const checklistTemplateSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  /** The department, e.g. "Stores (RM)" — the workbook sheet name, which is authoritative. */
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  /** Workbook order (R-6a), so the catalogue lists departments as the business lists them. */
  sortOrder: z.number().int(),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  /** The currently published version, when there is one. At most one exists per template. */
  publishedVersionId: uuidSchema.nullable(),
  publishedVersionNumber: z.number().int().nullable(),
});
export type ChecklistTemplate = z.infer<typeof checklistTemplateSchema>;

export const checklistQuestionSchema = z.object({
  id: uuidSchema,
  versionId: uuidSchema,
  section: sSectionSchema,
  orderInSection: z.number().int(),
  globalOrder: z.number().int(),
  text: z.string(),
  guidance: z.string().nullable(),
  allowsNa: z.boolean(),
  requiresEvidenceOnNonconformity: z.boolean(),
});
export type ChecklistQuestion = z.infer<typeof checklistQuestionSchema>;

export const checklistVersionSchema = z.object({
  id: uuidSchema,
  templateId: uuidSchema,
  templateCode: z.string(),
  templateName: z.string(),
  versionNumber: z.number().int(),
  status: checklistVersionStatusSchema,
  questionsPerSection: z.number().int(),
  totalQuestions: z.number().int(),
  publishedAt: isoDateTimeSchema.nullable(),
  publishedByUserId: uuidSchema.nullable(),
  supersededAt: isoDateTimeSchema.nullable(),
  supersededByVersionId: uuidSchema.nullable(),
  sourceImportJobId: uuidSchema.nullable(),
  /** SHA-256 over the ordered question set — the duplicate-import check of stage 4. */
  contentHash: z.string(),
  createdAt: isoDateTimeSchema,
});
export type ChecklistVersion = z.infer<typeof checklistVersionSchema>;

/**
 * A version with its questions. `Cache-Control: immutable` on a published version is safe
 * precisely because CV-1 makes it immutable in the database, not merely by convention.
 */
export const checklistVersionDetailSchema = checklistVersionSchema.extend({
  questions: z.array(checklistQuestionSchema),
});
export type ChecklistVersionDetail = z.infer<typeof checklistVersionDetailSchema>;

export const listChecklistVersionsQuerySchema = paginationQuerySchema.extend({
  status: checklistVersionStatusSchema.optional(),
  templateId: uuidSchema.optional(),
});
export type ListChecklistVersionsQuery = z.infer<typeof listChecklistVersionsQuerySchema>;

export const listChecklistTemplatesQuerySchema = paginationQuerySchema.extend({
  includeArchived: z.coerce.boolean().default(false),
});
export type ListChecklistTemplatesQuery = z.infer<typeof listChecklistTemplatesQuerySchema>;

// ---------------------------------------------------------------------------- import

export const IMPORT_SEVERITIES = ['OK', 'WARNING', 'ERROR'] as const;
export const importSeveritySchema = z.enum(IMPORT_SEVERITIES);
export type ImportSeverity = z.infer<typeof importSeveritySchema>;

/**
 * One parsed workbook row, with its verdict. Rows are kept for every row the parser
 * looked at — not only the failures — so the validation report can show a Super Admin what
 * was read as well as what was rejected.
 */
export const checklistImportRowSchema = z.object({
  id: uuidSchema,
  sheetId: uuidSchema,
  sheetName: z.string(),
  sourceRowNumber: z.number().int(),
  parsedSection: sSectionSchema.nullable(),
  parsedOrder: z.number().int().nullable(),
  parsedGlobalOrder: z.number().int().nullable(),
  parsedText: z.string().nullable(),
  severity: importSeveritySchema,
  messages: z.array(z.string()),
});
export type ChecklistImportRow = z.infer<typeof checklistImportRowSchema>;

/**
 * One workbook sheet, which becomes one template version.
 *
 * The workbook is nine department sheets in one file (R-6a/R-6d), so a job fans out to
 * many sheets and each sheet carries its own duplicate check and its own committed
 * version. `checklist_version.source_import_job_id` remains the provenance link back here.
 */
export const checklistImportSheetSchema = z.object({
  id: uuidSchema,
  jobId: uuidSchema,
  sheetName: z.string(),
  sheetIndex: z.number().int(),
  templateCode: z.string(),
  templateName: z.string(),
  /** Null until the sheet is matched to an existing template — then it is a new template. */
  templateId: uuidSchema.nullable(),
  contentHash: z.string(),
  questionCount: z.number().int(),
  severity: importSeveritySchema,
  /** Set when stage 4 found the same content already stored under this template. */
  duplicateOfVersionId: uuidSchema.nullable(),
  duplicateOfVersionNumber: z.number().int().nullable(),
  /** True when the duplicate is the *published* version: nothing to import (stage 4 BLOCK). */
  duplicateIsPublished: z.boolean(),
  committedVersionId: uuidSchema.nullable(),
  messages: z.array(z.string()),
});
export type ChecklistImportSheet = z.infer<typeof checklistImportSheetSchema>;

export const checklistImportJobSchema = z.object({
  id: uuidSchema,
  uploadedByUserId: uuidSchema,
  fileName: z.string(),
  fileObjectKey: z.string(),
  fileChecksum: z.string(),
  fileByteSize: z.number().int(),
  status: importJobStatusSchema,
  sheetCount: z.number().int(),
  parsedRowCount: z.number().int(),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  previewExpiresAt: isoDateTimeSchema.nullable(),
  errorReportObjectKey: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ChecklistImportJob = z.infer<typeof checklistImportJobSchema>;

/** One question as it differs between the incoming sheet and the published version. */
export const checklistDiffEntrySchema = z.object({
  section: sSectionSchema,
  orderInSection: z.number().int(),
  globalOrder: z.number().int(),
  change: z.enum(['ADDED', 'REMOVED', 'CHANGED', 'UNCHANGED']),
  currentText: z.string().nullable(),
  incomingText: z.string().nullable(),
});
export type ChecklistDiffEntry = z.infer<typeof checklistDiffEntrySchema>;

/** The side-by-side preview for one sheet: what exists today against what would land. */
export const checklistSheetDiffSchema = z.object({
  sheetId: uuidSchema,
  sheetName: z.string(),
  templateCode: z.string(),
  currentVersionId: uuidSchema.nullable(),
  currentVersionNumber: z.number().int().nullable(),
  added: z.number().int(),
  removed: z.number().int(),
  changed: z.number().int(),
  unchanged: z.number().int(),
  entries: z.array(checklistDiffEntrySchema),
});
export type ChecklistSheetDiff = z.infer<typeof checklistSheetDiffSchema>;

/**
 * Stage 5. **Nothing has been written to `checklist_version` when this is served** — a bad
 * spreadsheet can never leave half a checklist behind.
 */
export const checklistImportPreviewSchema = z.object({
  job: checklistImportJobSchema,
  sheets: z.array(checklistImportSheetSchema),
  /** Sheets in the file that are not checklists — the workbook's three legacy planning tabs. */
  skippedSheets: z.array(z.object({ name: z.string(), reason: z.string() })),
  rows: z.array(checklistImportRowSchema),
  errors: z.array(checklistImportRowSchema),
  warnings: z.array(checklistImportRowSchema),
  diffs: z.array(checklistSheetDiffSchema),
});
export type ChecklistImportPreview = z.infer<typeof checklistImportPreviewSchema>;

/**
 * Commit takes the sheets to apply. Omitting it commits every sheet that validated, which
 * is what the nine-sheet department workbook wants; naming them is how a Super Admin
 * re-imports one department without touching the other eight.
 */
export const commitChecklistImportRequestSchema = z.object({
  sheetIds: z.array(uuidSchema).min(1).optional(),
  /** Publish each committed version immediately instead of leaving it DRAFT. */
  publish: z.boolean().default(false),
});
export type CommitChecklistImportRequest = z.infer<typeof commitChecklistImportRequestSchema>;

export const commitChecklistImportResponseSchema = z.object({
  jobId: uuidSchema,
  versions: z.array(checklistVersionSchema),
});
export type CommitChecklistImportResponse = z.infer<typeof commitChecklistImportResponseSchema>;

export const listChecklistImportsQuerySchema = paginationQuerySchema.extend({
  status: importJobStatusSchema.optional(),
});
export type ListChecklistImportsQuery = z.infer<typeof listChecklistImportsQuerySchema>;

export const updateChecklistTemplateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: optional(z.string().trim().max(2000)),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' });
export type UpdateChecklistTemplateRequest = z.infer<typeof updateChecklistTemplateRequestSchema>;
