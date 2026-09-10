import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  checklistImportJobs,
  checklistImportRows,
  checklistImportSheets,
  checklistQuestions,
  checklistTemplates,
  checklistVersions,
  type Database,
  type Transaction,
} from '@audit5s/db';
import type { ImportSeverity, ListChecklistImportsQuery, SSection } from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { BaseRepository } from '../../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../../common/auth/resolvers';
import { DATABASE } from '../../../infrastructure/database/database.module';
import { QUEUES, QueueService } from '../../../infrastructure/queue/queue.service';
import { setActorContext } from '../../users/users.repository';

export interface SheetToPersist {
  sheetName: string;
  sheetIndex: number;
  templateCode: string;
  templateName: string;
  templateId: string | null;
  contentHash: string;
  questionCount: number;
  severity: ImportSeverity;
  duplicateOfVersionId: string | null;
  duplicateIsPublished: boolean;
  messages: string[];
  rows: Array<{
    sourceRowNumber: number;
    raw: unknown;
    parsedSection: SSection | null;
    parsedOrder: number | null;
    parsedGlobalOrder: number | null;
    parsedText: string | null;
    severity: ImportSeverity;
    messages: string[];
  }>;
}

export interface QuestionToCommit {
  section: SSection;
  orderInSection: number;
  globalOrder: number;
  text: string;
}

@Injectable()
export class ChecklistImportRepository extends BaseRepository {
  constructor(
    @Inject(DATABASE) db: Database,
    resolvers: ScopeResolverRegistry,
    private readonly queue: QueueService,
  ) {
    super(db, resolvers);
  }

  /** `checklist_import:*` is `organization` for a Super Admin and denied to everyone else. */
  private everything(scope: ScopeContext) {
    return this.scoped(scope, {});
  }

  async createJob(
    scope: ScopeContext,
    input: {
      fileName: string;
      fileObjectKey: string;
      fileChecksum: string;
      fileByteSize: number;
    },
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .insert(checklistImportJobs)
        .values({ ...input, uploadedByUserId: scope.actor.userId })
        .returning({ id: checklistImportJobs.id });
      return row!.id;
    });
  }

  /**
   * Moves the job to VALIDATING and enqueues the parse **in the same transaction**.
   *
   * This is DECISIONS.md R-2 in one method: the status change and the job row commit
   * together, so a worker never sees a job whose status change rolled back, and there is
   * no outbox table doing the same work twice.
   */
  async markValidatingAndEnqueue(scope: ScopeContext, jobId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const [row] = await tx
        .update(checklistImportJobs)
        .set({ status: 'VALIDATING' })
        .where(
          and(
            eq(checklistImportJobs.id, jobId),
            inArray(checklistImportJobs.status, ['UPLOADED', 'PREVIEW', 'FAILED']),
            this.everything(scope),
          ),
        )
        .returning({ id: checklistImportJobs.id });

      if (!row) return false;

      await this.queue.sendInTransaction(tx as Transaction, QUEUES.checklistImport, {
        jobId,
        uploadedByUserId: scope.actor.userId,
      });
      return true;
    });
  }

  /**
   * The key is set after the object lands, not before.
   *
   * A row that claims an object exists when the write failed is worse than a row that
   * briefly says `pending`: the worker would read a key that resolves to nothing and the
   * failure would surface a stage later, with no file to point at.
   */
  async setFileObjectKey(scope: ScopeContext, jobId: string, key: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(checklistImportJobs)
        .set({ fileObjectKey: key })
        .where(and(eq(checklistImportJobs.id, jobId), this.everything(scope)));
    });
  }

  /**
   * The questions a validated sheet would commit, read back from the parse results.
   *
   * Stage 6 works from these rows rather than re-parsing the workbook, so what is
   * committed is exactly what the Super Admin previewed — not a second read of a file
   * that could have been replaced in between.
   */
  async incomingQuestionsOfSheet(
    scope: ScopeContext,
    sheetId: string,
  ): Promise<QuestionToCommit[]> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const rows = await tx
        .select({
          section: checklistImportRows.parsedSection,
          orderInSection: checklistImportRows.parsedOrder,
          globalOrder: checklistImportRows.parsedGlobalOrder,
          text: checklistImportRows.parsedText,
        })
        .from(checklistImportRows)
        .where(and(eq(checklistImportRows.sheetId, sheetId), this.everything(scope)))
        .orderBy(asc(checklistImportRows.parsedGlobalOrder));

      return rows
        .filter(
          (row): row is { section: SSection; orderInSection: number; globalOrder: number; text: string } =>
            row.section !== null &&
            row.orderInSection !== null &&
            row.globalOrder !== null &&
            row.text !== null,
        )
        .map((row) => ({
          section: row.section,
          orderInSection: row.orderInSection,
          globalOrder: row.globalOrder,
          text: row.text,
        }));
    });
  }

  async findJob(scope: ScopeContext, jobId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select()
        .from(checklistImportJobs)
        .where(and(eq(checklistImportJobs.id, jobId), this.everything(scope)))
        .limit(1);
      return row ?? null;
    });
  }

  async listJobs(scope: ScopeContext, query: ListChecklistImportsQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const filters = [
        query.status ? eq(checklistImportJobs.status, query.status) : undefined,
        query.cursor ? gt(checklistImportJobs.id, query.cursor) : undefined,
      ].filter((filter) => filter !== undefined);

      return tx
        .select()
        .from(checklistImportJobs)
        .where(and(this.everything(scope), ...filters))
        .orderBy(desc(checklistImportJobs.createdAt))
        .limit(query.limit + 1);
    });
  }

  async findSheets(scope: ScopeContext, jobId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({
          sheet: checklistImportSheets,
          duplicateVersionNumber: checklistVersions.versionNumber,
        })
        .from(checklistImportSheets)
        .leftJoin(
          checklistVersions,
          eq(checklistVersions.id, checklistImportSheets.duplicateOfVersionId),
        )
        .where(and(eq(checklistImportSheets.jobId, jobId), this.everything(scope)))
        .orderBy(asc(checklistImportSheets.sheetIndex));
    });
  }

  async findRows(scope: ScopeContext, jobId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({ row: checklistImportRows, sheetName: checklistImportSheets.sheetName })
        .from(checklistImportRows)
        .innerJoin(checklistImportSheets, eq(checklistImportSheets.id, checklistImportRows.sheetId))
        .where(and(eq(checklistImportRows.jobId, jobId), this.everything(scope)))
        .orderBy(asc(checklistImportSheets.sheetIndex), asc(checklistImportRows.sourceRowNumber));
    });
  }

  /**
   * Replaces the job's parse results with a fresh run.
   *
   * Stages 2–5 write only here — never to `checklist_version`. A re-validate must leave
   * no trace of the previous attempt, so the old sheets and rows go first; that is also
   * why the two tables cascade from the job.
   */
  async storeParseResults(
    scope: ScopeContext,
    jobId: string,
    input: {
      sheets: SheetToPersist[];
      skippedSheets: Array<{ name: string; reason: string }>;
      status: 'PREVIEW' | 'FAILED';
      previewExpiresAt: Date | null;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      await tx.delete(checklistImportRows).where(eq(checklistImportRows.jobId, jobId));
      await tx.delete(checklistImportSheets).where(eq(checklistImportSheets.jobId, jobId));

      let parsedRowCount = 0;
      let errorCount = 0;
      let warningCount = 0;

      for (const sheet of input.sheets) {
        const [inserted] = await tx
          .insert(checklistImportSheets)
          .values({
            jobId,
            sheetName: sheet.sheetName,
            sheetIndex: sheet.sheetIndex,
            templateCode: sheet.templateCode,
            templateName: sheet.templateName,
            templateId: sheet.templateId,
            contentHash: sheet.contentHash,
            questionCount: sheet.questionCount,
            severity: sheet.severity,
            duplicateOfVersionId: sheet.duplicateOfVersionId,
            duplicateIsPublished: sheet.duplicateIsPublished,
            messages: sheet.messages,
          })
          .returning({ id: checklistImportSheets.id });

        const sheetId = inserted!.id;
        parsedRowCount += sheet.rows.length;

        if (sheet.rows.length > 0) {
          await tx.insert(checklistImportRows).values(
            sheet.rows.map((row) => {
              if (row.severity === 'ERROR') errorCount += 1;
              if (row.severity === 'WARNING') warningCount += 1;
              return {
                jobId,
                sheetId,
                sourceRowNumber: row.sourceRowNumber,
                raw: row.raw,
                parsedSection: row.parsedSection,
                parsedOrder: row.parsedOrder,
                parsedGlobalOrder: row.parsedGlobalOrder,
                parsedText: row.parsedText,
                severity: row.severity,
                messages: row.messages,
              };
            }),
          );
        }

        // A sheet-level problem (a missing section, say) belongs to no row, so it is
        // counted here or the report would say "0 errors" over a rejected sheet.
        if (sheet.severity === 'ERROR') errorCount += sheet.messages.length || 1;
      }

      await tx
        .update(checklistImportJobs)
        .set({
          status: input.status,
          sheetCount: input.sheets.length,
          skippedSheets: input.skippedSheets,
          parsedRowCount,
          errorCount,
          warningCount,
          previewExpiresAt: input.previewExpiresAt,
        })
        .where(eq(checklistImportJobs.id, jobId));
    });
  }

  async setJobStatus(
    scope: ScopeContext,
    jobId: string,
    status: 'FAILED' | 'COMMITTED' | 'CANCELLED',
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(checklistImportJobs)
        .set({ status })
        .where(and(eq(checklistImportJobs.id, jobId), this.everything(scope)));
    });
  }

  async setErrorReportKey(scope: ScopeContext, jobId: string, key: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(checklistImportJobs)
        .set({ errorReportObjectKey: key })
        .where(and(eq(checklistImportJobs.id, jobId), this.everything(scope)));
    });
  }

  /** Templates keyed by code, for matching a sheet to an existing department. */
  async templatesByCode(scope: ScopeContext, codes: string[]) {
    if (codes.length === 0) return new Map<string, { id: string; name: string; sortOrder: number }>();
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const rows = await tx
        .select({
          id: checklistTemplates.id,
          code: checklistTemplates.code,
          name: checklistTemplates.name,
          sortOrder: checklistTemplates.sortOrder,
        })
        .from(checklistTemplates)
        .where(and(inArray(checklistTemplates.code, codes), this.everything(scope)));
      return new Map(rows.map((row) => [row.code, row]));
    });
  }

  /** Every stored version of a template, for the stage 4 duplicate check. */
  async versionsOfTemplate(scope: ScopeContext, templateId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({
          id: checklistVersions.id,
          versionNumber: checklistVersions.versionNumber,
          status: checklistVersions.status,
          contentHash: checklistVersions.contentHash,
        })
        .from(checklistVersions)
        .where(and(eq(checklistVersions.templateId, templateId), this.everything(scope)))
        .orderBy(desc(checklistVersions.versionNumber));
    });
  }

  /** The published version's questions, for the stage 5 side-by-side diff. */
  async publishedQuestionsOfTemplate(scope: ScopeContext, templateId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({
          versionId: checklistVersions.id,
          versionNumber: checklistVersions.versionNumber,
          section: checklistQuestions.section,
          orderInSection: checklistQuestions.orderInSection,
          globalOrder: checklistQuestions.globalOrder,
          text: checklistQuestions.text,
        })
        .from(checklistVersions)
        .leftJoin(checklistQuestions, eq(checklistQuestions.versionId, checklistVersions.id))
        .where(
          and(
            eq(checklistVersions.templateId, templateId),
            eq(checklistVersions.status, 'PUBLISHED'),
            this.everything(scope),
          ),
        )
        .orderBy(asc(checklistQuestions.globalOrder));
    });
  }

  /**
   * Stage 6, for one sheet: create the template if it is new, allocate the next version
   * number, write the version and its questions, and record the link both ways.
   *
   * One transaction per sheet, not one for the whole workbook: nine departments are nine
   * independent checklists, and a single bad sheet should not cost the other eight.
   */
  async commitSheet(
    scope: ScopeContext,
    input: {
      jobId: string;
      sheetId: string;
      templateId: string | null;
      templateCode: string;
      templateName: string;
      sortOrder: number;
      contentHash: string;
      questionsPerSection: number;
      questions: QuestionToCommit[];
    },
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      let templateId = input.templateId;
      if (!templateId) {
        const [created] = await tx
          .insert(checklistTemplates)
          .values({
            code: input.templateCode,
            name: input.templateName,
            sortOrder: input.sortOrder,
          })
          .returning({ id: checklistTemplates.id });
        templateId = created!.id;
      }

      const [highest] = await tx
        .select({ versionNumber: checklistVersions.versionNumber })
        .from(checklistVersions)
        .where(eq(checklistVersions.templateId, templateId))
        .orderBy(desc(checklistVersions.versionNumber))
        .limit(1);

      const [version] = await tx
        .insert(checklistVersions)
        .values({
          templateId,
          versionNumber: (highest?.versionNumber ?? 0) + 1,
          status: 'DRAFT',
          questionsPerSection: input.questionsPerSection,
          totalQuestions: input.questions.length,
          sourceImportJobId: input.jobId,
          contentHash: input.contentHash,
        })
        .returning({ id: checklistVersions.id });

      const versionId = version!.id;

      await tx.insert(checklistQuestions).values(
        input.questions.map((question) => ({
          versionId,
          section: question.section,
          orderInSection: question.orderInSection,
          globalOrder: question.globalOrder,
          text: question.text,
        })),
      );

      await tx
        .update(checklistImportSheets)
        .set({ committedVersionId: versionId, templateId })
        .where(eq(checklistImportSheets.id, input.sheetId));

      return versionId;
    });
  }

  /** The highest `sort_order` in use, so a new department lands after the known ones. */
  async maxTemplateSortOrder(scope: ScopeContext): Promise<number> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const result = await tx.execute<{ max: number | null }>(
        sql`SELECT max(sort_order) AS max FROM checklist_template`,
      );
      return result.rows[0]?.max ?? 0;
    });
  }
}

export type ImportJobRow = NonNullable<Awaited<ReturnType<ChecklistImportRepository['findJob']>>>;
export type ImportSheetRow = Awaited<
  ReturnType<ChecklistImportRepository['findSheets']>
>[number];
export type ImportRowRow = Awaited<ReturnType<ChecklistImportRepository['findRows']>>[number];
