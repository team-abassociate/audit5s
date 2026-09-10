import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ChecklistDiffEntry,
  ChecklistImportJob,
  ChecklistImportPreview,
  ChecklistImportRow,
  ChecklistImportSheet,
  ChecklistSheetDiff,
  ChecklistVersion,
  CommitChecklistImportRequest,
  CommitChecklistImportResponse,
  ImportSeverity,
  ListChecklistImportsQuery,
  Page,
} from '@audit5s/contracts';
import {
  QUESTIONS_PER_SECTION,
  canonicalChecklistSignature,
  diffChecklistQuestions,
  isChecklistSheet,
  parseChecklistSheet,
  templateCodeForSheet,
  validateChecklistSheet,
  type ScopeContext,
  type SheetGrid,
} from '@audit5s/domain';
import { CONFIG, type AppConfig } from '../../../config/env';
import { AppError } from '../../../common/errors';
import { AuditLogService } from '../../../common/audit-log/audit-log.service';
import { ObjectStorage } from '../../../infrastructure/storage/object-storage';
import { ChecklistsService } from '../checklists.service';
import { ChecklistErrorReportWriter } from './error-report.writer';
import {
  ChecklistImportRepository,
  type ImportJobRow,
  type SheetToPersist,
} from './checklist-import.repository';
import { WorkbookReader, WorkbookRejected } from './workbook-reader';

export interface UploadedWorkbook {
  fileName: string;
  contentType: string;
  body: Buffer;
}

/**
 * The six-stage import of ARCHITECTURE.md §8.5.
 *
 *   1 UPLOAD     store the file, checksum it, create the job        → UPLOADED
 *   2 PARSE      read sheets through the ChecklistImportProfile     → VALIDATING
 *   3 VALIDATE   per-row rules → ChecklistImportRow with severity
 *   4 DUPLICATE  content hash against every stored version
 *   5 PREVIEW    side-by-side diff, error/warning report            → PREVIEW
 *   6 COMMIT     create version + questions in one transaction      → COMMITTED
 *
 * **Nothing is written to `checklist_version` before stage 6.** Stages 2–5 write only to
 * the import tables, so a bad spreadsheet can never leave half a checklist behind — which
 * is the whole reason preview is a separate step rather than a dry-run flag on commit.
 *
 * Stages 2–5 run in `worker-general` (STACK.md §7 step 6). `runPipeline` is what the pg-boss
 * handler calls and what the seed calls, so there is exactly one implementation of the
 * import and the seed is genuinely its first integration test.
 */
@Injectable()
export class ChecklistImportService {
  private readonly logger = new Logger(ChecklistImportService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly repository: ChecklistImportRepository,
    private readonly checklists: ChecklistsService,
    private readonly storage: ObjectStorage,
    private readonly reader: WorkbookReader,
    private readonly errorReport: ChecklistErrorReportWriter,
    private readonly auditLog: AuditLogService,
  ) {}

  // ------------------------------------------------------------------ stage 1
  async upload(scope: ScopeContext, file: UploadedWorkbook): Promise<ChecklistImportJob> {
    try {
      // Rejected before a byte reaches the parser, and by content rather than by the
      // name or the declared type (§12.8).
      this.reader.assertAcceptable(file.body, {
        maxBytes: this.config.CHECKLIST_IMPORT_MAX_BYTES,
      });
    } catch (error) {
      if (error instanceof WorkbookRejected) {
        throw AppError.badRequest('IMPORT_FILE_REJECTED', 'Rejected upload', error.message);
      }
      throw error;
    }

    const checksum = createHash('sha256').update(file.body).digest('hex');
    // The key is server-generated: a filename from a client is never part of a path
    // (§12.8). The job id makes it unique; the checksum makes a re-upload traceable.
    const jobId = await this.repository.createJob(scope, {
      fileName: file.fileName,
      fileObjectKey: 'pending',
      fileChecksum: checksum,
      fileByteSize: file.body.byteLength,
    });

    const key = `import/${jobId}/workbook.xlsx`;
    await this.storage.put(key, file.body, file.contentType);
    await this.repository.setFileObjectKey(scope, jobId, key);

    return this.getJob(scope, jobId);
  }

  /**
   * Stage 2's trigger. Returns immediately: parsing a workbook is worker work, not
   * request work (§12.8 — "parsed in a worker with a memory cap").
   */
  async requestValidation(scope: ScopeContext, jobId: string): Promise<ChecklistImportJob> {
    const job = await this.mustFindJob(scope, jobId);
    if (job.status === 'COMMITTED') {
      throw AppError.conflict(
        'CONFLICT',
        'This import has already been committed. Upload the workbook again to import it afresh.',
      );
    }

    const enqueued = await this.repository.markValidatingAndEnqueue(scope, jobId);
    if (!enqueued) {
      throw AppError.conflict('CONFLICT', `An import in status ${job.status} cannot be validated`);
    }

    return this.getJob(scope, jobId);
  }

  // --------------------------------------------------------------- stages 2–5
  /**
   * Runs PARSE, VALIDATE, DUPLICATE and PREVIEW for one job.
   *
   * Called by the `checklist.import` worker and, directly, by the seed. It writes only to
   * the import tables.
   */
  async runPipeline(scope: ScopeContext, jobId: string): Promise<void> {
    const job = await this.mustFindJob(scope, jobId);

    let grids: SheetGrid[];
    try {
      const body = await this.storage.get(job.fileObjectKey);
      grids = await this.reader.read(body, { maxBytes: this.config.CHECKLIST_IMPORT_MAX_BYTES });
    } catch (error) {
      this.logger.warn(`import ${jobId}: ${error instanceof Error ? error.message : 'read failed'}`);
      await this.repository.storeParseResults(scope, jobId, {
        sheets: [],
        skippedSheets: [
          {
            name: job.fileName,
            reason: error instanceof Error ? error.message : 'The workbook could not be read',
          },
        ],
        status: 'FAILED',
        previewExpiresAt: null,
      });
      return;
    }

    const skippedSheets: Array<{ name: string; reason: string }> = [];
    const checklistGrids = grids.filter((grid) => {
      if (isChecklistSheet(grid)) return true;
      // Q7: the workbook's planning tabs are replaced by the platform, never imported.
      skippedSheets.push({
        name: grid.name,
        reason: 'Cell A1 is not a "5S AUDIT CHECK SHEET – …" title, so this is not a checklist',
      });
      return false;
    });

    const codes = checklistGrids.map((grid) => templateCodeForSheet(grid.name));
    const existingTemplates = await this.repository.templatesByCode(scope, codes);

    const sheets: SheetToPersist[] = [];

    for (const grid of checklistGrids) {
      const validated = validateChecklistSheet(parseChecklistSheet(grid));
      const templateCode = validated.parsed.templateCode;
      const template = existingTemplates.get(templateCode) ?? null;

      const contentHash = hashQuestions(canonicalChecklistSignature(validated.questions));
      const messages = [...validated.messages];
      let severity = validated.severity;
      let duplicateOfVersionId: string | null = null;
      let duplicateIsPublished = false;

      // ------------------------------------------------------------- stage 4
      if (template && validated.severity !== 'ERROR') {
        const versions = await this.repository.versionsOfTemplate(scope, template.id);
        const duplicate = versions.find((version) => version.contentHash === contentHash);
        if (duplicate) {
          duplicateOfVersionId = duplicate.id;
          duplicateIsPublished = duplicate.status === 'PUBLISHED';
          if (duplicateIsPublished) {
            // BLOCK: importing the published checklist again would create a v(n+1) that
            // is word-for-word v(n), and every audit in flight would be re-pinned for no
            // reason. Not an ERROR — the file is fine, there is simply nothing to do.
            messages.push(
              `No changes to import: this sheet is identical to published version ${duplicate.versionNumber}`,
            );
            severity = worst(severity, 'WARNING');
          } else {
            messages.push(
              `This sheet is identical to version ${duplicate.versionNumber} (${duplicate.status.toLowerCase()}) — committing it would revert to that wording`,
            );
            severity = worst(severity, 'WARNING');
          }
        }
      }

      sheets.push({
        sheetName: validated.parsed.name,
        sheetIndex: validated.parsed.index,
        templateCode,
        templateName: validated.parsed.name,
        templateId: template?.id ?? null,
        contentHash,
        questionCount: validated.questions.length,
        severity,
        duplicateOfVersionId,
        duplicateIsPublished,
        messages,
        rows: validated.rows.map((row) => ({
          sourceRowNumber: row.sourceRowNumber,
          raw: row.raw,
          parsedSection: row.section,
          parsedOrder: row.orderInSection,
          parsedGlobalOrder: row.globalOrder,
          parsedText: row.text,
          severity: row.severity,
          messages: row.messages,
        })),
      });
    }

    // A file with no checklist sheet at all is a failure, not an empty preview: the
    // Super Admin uploaded the wrong file and should be told so.
    const status = sheets.length === 0 ? 'FAILED' : 'PREVIEW';

    await this.repository.storeParseResults(scope, jobId, {
      sheets,
      skippedSheets,
      status,
      previewExpiresAt:
        status === 'PREVIEW'
          ? new Date(Date.now() + this.config.CHECKLIST_IMPORT_PREVIEW_TTL_HOURS * 3600 * 1000)
          : null,
    });

    await this.writeErrorReportIfNeeded(scope, jobId, sheets);
  }

  private async writeErrorReportIfNeeded(
    scope: ScopeContext,
    jobId: string,
    sheets: SheetToPersist[],
  ): Promise<void> {
    const hasFindings = sheets.some(
      (sheet) =>
        sheet.severity !== 'OK' || sheet.rows.some((row) => row.severity !== 'OK'),
    );
    if (!hasFindings) return;

    const workbook = await this.errorReport.build(sheets);
    const key = `import/${jobId}/error-report.xlsx`;
    await this.storage.put(
      key,
      workbook,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    await this.repository.setErrorReportKey(scope, jobId, key);
  }

  // ------------------------------------------------------------------ stage 5
  async preview(scope: ScopeContext, jobId: string): Promise<ChecklistImportPreview> {
    const job = await this.mustFindJob(scope, jobId);

    if (job.status === 'UPLOADED' || job.status === 'VALIDATING') {
      throw AppError.conflict(
        'IMPORT_NOT_PREVIEWED',
        'This import has not finished validating yet',
      );
    }

    const sheetRows = await this.repository.findSheets(scope, jobId);
    const rows = await this.repository.findRows(scope, jobId);

    const diffs: ChecklistSheetDiff[] = [];
    for (const { sheet } of sheetRows) {
      diffs.push(await this.diffForSheet(scope, sheet));
    }

    const mapped = rows.map(({ row, sheetName }) => toImportRow(row, sheetName));

    return {
      job: toJob(job),
      sheets: sheetRows.map(({ sheet, duplicateVersionNumber }) =>
        toSheet(sheet, duplicateVersionNumber),
      ),
      skippedSheets: job.skippedSheets,
      rows: mapped,
      errors: mapped.filter((row) => row.severity === 'ERROR'),
      warnings: mapped.filter((row) => row.severity === 'WARNING'),
      diffs,
    };
  }

  /** The side-by-side comparison against whatever this template has published today. */
  private async diffForSheet(
    scope: ScopeContext,
    sheet: { id: string; sheetName: string; templateCode: string; templateId: string | null },
  ): Promise<ChecklistSheetDiff> {
    const incoming = await this.repository.incomingQuestionsOfSheet(scope, sheet.id);

    const current = sheet.templateId
      ? await this.repository.publishedQuestionsOfTemplate(scope, sheet.templateId)
      : [];
    const currentQuestions = current
      .filter((row) => row.section !== null)
      .map((row) => ({
        section: row.section!,
        orderInSection: row.orderInSection!,
        globalOrder: row.globalOrder!,
        text: row.text!,
      }));

    const entries: ChecklistDiffEntry[] = diffChecklistQuestions(currentQuestions, incoming);

    return {
      sheetId: sheet.id,
      sheetName: sheet.sheetName,
      templateCode: sheet.templateCode,
      currentVersionId: current[0]?.versionId ?? null,
      currentVersionNumber: current[0]?.versionNumber ?? null,
      added: entries.filter((entry) => entry.change === 'ADDED').length,
      removed: entries.filter((entry) => entry.change === 'REMOVED').length,
      changed: entries.filter((entry) => entry.change === 'CHANGED').length,
      unchanged: entries.filter((entry) => entry.change === 'UNCHANGED').length,
      entries,
    };
  }

  async errorReportKey(scope: ScopeContext, jobId: string): Promise<string> {
    const job = await this.mustFindJob(scope, jobId);
    if (!job.errorReportObjectKey) {
      throw AppError.notFound('This import produced no errors or warnings to report');
    }
    return job.errorReportObjectKey;
  }

  async errorReportBytes(scope: ScopeContext, jobId: string): Promise<Buffer> {
    return this.storage.get(await this.errorReportKey(scope, jobId));
  }

  // ------------------------------------------------------------------ stage 6
  async commit(
    scope: ScopeContext,
    jobId: string,
    request: CommitChecklistImportRequest,
  ): Promise<CommitChecklistImportResponse> {
    const job = await this.mustFindJob(scope, jobId);

    if (job.status !== 'PREVIEW') {
      throw AppError.conflict(
        'IMPORT_NOT_PREVIEWED',
        `Only a previewed import may be committed; this one is ${job.status}`,
      );
    }
    if (job.previewExpiresAt && job.previewExpiresAt.getTime() < Date.now()) {
      // The checklist may have moved on since. Re-validating is cheap; committing a
      // stale diff is not.
      throw AppError.conflict(
        'IMPORT_PREVIEW_EXPIRED',
        'This preview has expired. Validate the import again before committing.',
      );
    }

    const sheetRows = await this.repository.findSheets(scope, jobId);
    const wanted = request.sheetIds ? new Set(request.sheetIds) : null;
    const selected = sheetRows
      .map(({ sheet }) => sheet)
      .filter((sheet) => (wanted ? wanted.has(sheet.id) : true));

    if (selected.length === 0) {
      throw AppError.validation('No sheets selected to commit');
    }

    const blocked = selected.filter((sheet) => sheet.severity === 'ERROR');
    if (blocked.length > 0) {
      throw AppError.conflict(
        'IMPORT_VALIDATION_FAILED',
        `These sheets have errors and cannot be committed: ${blocked
          .map((sheet) => sheet.sheetName)
          .join(', ')}`,
      );
    }

    // Stage 4's BLOCK, applied at the moment of writing rather than only reported: a
    // sheet identical to the published version has nothing to contribute.
    const unchanged = selected.filter((sheet) => sheet.duplicateIsPublished);
    const committable = selected.filter((sheet) => !sheet.duplicateIsPublished);

    if (committable.length === 0) {
      throw AppError.conflict(
        'IMPORT_NO_CHANGES',
        `No changes to import: ${unchanged
          .map((sheet) => sheet.sheetName)
          .join(', ')} already match the published checklist`,
      );
    }

    let nextSortOrder = (await this.repository.maxTemplateSortOrder(scope)) + 1;
    const versionIds: string[] = [];

    for (const sheet of committable) {
      const questions = await this.repository.incomingQuestionsOfSheet(scope, sheet.id);
      const versionId = await this.repository.commitSheet(scope, {
        jobId,
        sheetId: sheet.id,
        templateId: sheet.templateId,
        templateCode: sheet.templateCode,
        templateName: sheet.templateName,
        // A new department goes to the end; a known one keeps the order it already has.
        sortOrder: sheet.templateId ? 0 : nextSortOrder,
        contentHash: sheet.contentHash,
        questionsPerSection: QUESTIONS_PER_SECTION,
        questions,
      });
      if (!sheet.templateId) nextSortOrder += 1;
      versionIds.push(versionId);

      await this.auditLog.record({
        action: 'checklist.imported',
        resourceType: 'checklist_version',
        resourceId: versionId,
        after: {
          jobId,
          sheetName: sheet.sheetName,
          templateCode: sheet.templateCode,
          questionCount: questions.length,
        },
      });
    }

    await this.repository.setJobStatus(scope, jobId, 'COMMITTED');

    const versions: ChecklistVersion[] = [];
    for (const versionId of versionIds) {
      versions.push(
        request.publish
          ? await this.checklists.publish(scope, versionId)
          : await this.checklists.getVersion(scope, versionId),
      );
    }

    return { jobId, versions };
  }

  // ---------------------------------------------------------------- accessors
  async getJob(scope: ScopeContext, jobId: string): Promise<ChecklistImportJob> {
    return toJob(await this.mustFindJob(scope, jobId));
  }

  async listJobs(
    scope: ScopeContext,
    query: ListChecklistImportsQuery,
  ): Promise<Page<ChecklistImportJob>> {
    const rows = await this.repository.listJobs(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toJob), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  private async mustFindJob(scope: ScopeContext, jobId: string): Promise<ImportJobRow> {
    const job = await this.repository.findJob(scope, jobId);
    if (!job) {
      throw AppError.notFound('No such import job');
    }
    return job;
  }
}

function worst(a: ImportSeverity, b: ImportSeverity): ImportSeverity {
  if (a === 'ERROR' || b === 'ERROR') return 'ERROR';
  if (a === 'WARNING' || b === 'WARNING') return 'WARNING';
  return 'OK';
}

/** SHA-256 over the canonical signature `packages/domain` produces. */
export function hashQuestions(signature: string): string {
  return createHash('sha256').update(signature, 'utf8').digest('hex');
}

function toJob(row: ImportJobRow): ChecklistImportJob {
  return {
    id: row.id,
    uploadedByUserId: row.uploadedByUserId,
    fileName: row.fileName,
    fileObjectKey: row.fileObjectKey,
    fileChecksum: row.fileChecksum,
    fileByteSize: row.fileByteSize,
    status: row.status,
    sheetCount: row.sheetCount,
    parsedRowCount: row.parsedRowCount,
    errorCount: row.errorCount,
    warningCount: row.warningCount,
    previewExpiresAt: row.previewExpiresAt?.toISOString() ?? null,
    errorReportObjectKey: row.errorReportObjectKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type SheetEntity = Awaited<ReturnType<ChecklistImportRepository['findSheets']>>[number]['sheet'];

function toSheet(row: SheetEntity, duplicateVersionNumber: number | null): ChecklistImportSheet {
  return {
    id: row.id,
    jobId: row.jobId,
    sheetName: row.sheetName,
    sheetIndex: row.sheetIndex,
    templateCode: row.templateCode,
    templateName: row.templateName,
    templateId: row.templateId,
    contentHash: row.contentHash,
    questionCount: row.questionCount,
    severity: row.severity,
    duplicateOfVersionId: row.duplicateOfVersionId,
    duplicateOfVersionNumber: duplicateVersionNumber,
    duplicateIsPublished: row.duplicateIsPublished,
    committedVersionId: row.committedVersionId,
    messages: row.messages,
  };
}

type RowEntity = Awaited<ReturnType<ChecklistImportRepository['findRows']>>[number]['row'];

function toImportRow(row: RowEntity, sheetName: string): ChecklistImportRow {
  return {
    id: row.id,
    sheetId: row.sheetId,
    sheetName,
    sourceRowNumber: row.sourceRowNumber,
    parsedSection: row.parsedSection,
    parsedOrder: row.parsedOrder,
    parsedGlobalOrder: row.parsedGlobalOrder,
    parsedText: row.parsedText,
    severity: row.severity,
    messages: row.messages,
  };
}
