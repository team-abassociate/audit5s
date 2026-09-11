import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
// The type augmentation that puts `request.file()` on FastifyRequest. Imported for its
// declarations only — the plugin itself is registered once, in main.ts.
import '@fastify/multipart';
import {
  commitChecklistImportRequestSchema,
  listChecklistImportsQuerySchema,
  type ChecklistImportJob,
  type ChecklistImportPreview,
  type CommitChecklistImportRequest,
  type CommitChecklistImportResponse,
  type Page,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../../common/auth/decorators';
import { CurrentScope } from '../../../common/auth/current-scope.decorator';
import { AppError } from '../../../common/errors';
import { ZodValidationPipe } from '../../auth/zod.pipe';
import { ChecklistImportService } from './checklist-import.service';

/**
 * The import surface of §8.5. Every route is Super Admin only
 * (`checklist_import:upload|preview|commit`).
 *
 * Upload is multipart. The workbook is not media — it is a small administrative file the
 * API must inspect (magic bytes, size, then a parse) before it is worth storing — so
 * STACK.md §5's "media never transits the API" does not apply here; that rule is about
 * field photos, which go straight to object storage on a presigned PUT.
 */
@Controller('checklist-imports')
export class ChecklistImportController {
  constructor(private readonly imports: ChecklistImportService) {}

  @RequirePermission('checklist_import', 'upload')
  @Scope({ intent: 'write' })
  @Post()
  async upload(
    @CurrentScope() scope: ScopeContext,
    @Req() request: FastifyRequest,
  ): Promise<ChecklistImportJob> {
    const file = await request.file();
    if (!file) {
      throw AppError.validation('Send the workbook as a multipart file field named `file`');
    }
    return this.imports.upload(scope, {
      fileName: file.filename,
      contentType: file.mimetype,
      body: await file.toBuffer(),
    });
  }

  @RequirePermission('checklist_import', 'preview')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listChecklistImportsQuerySchema))
    query: ReturnType<typeof listChecklistImportsQuerySchema.parse>,
  ): Promise<Page<ChecklistImportJob>> {
    return this.imports.listJobs(scope, query);
  }

  @RequirePermission('checklist_import', 'preview')
  @Scope({ param: 'jobId', intent: 'read' })
  @Get(':jobId')
  get(
    @CurrentScope() scope: ScopeContext,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Promise<ChecklistImportJob> {
    return this.imports.getJob(scope, jobId);
  }

  /**
   * Stages 2–5, enqueued rather than run here: a workbook is parsed in `worker-general`
   * with a memory cap (§12.8), never inside a request. 202, then poll the preview.
   */
  @RequirePermission('checklist_import', 'preview')
  @Scope({ param: 'jobId', intent: 'write' })
  @Post(':jobId/validate')
  @HttpCode(HttpStatus.ACCEPTED)
  validate(
    @CurrentScope() scope: ScopeContext,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Promise<ChecklistImportJob> {
    return this.imports.requestValidation(scope, jobId);
  }

  /** Stage 5. Nothing has been written to `checklist_version` when this is served. */
  @RequirePermission('checklist_import', 'preview')
  @Scope({ param: 'jobId', intent: 'read' })
  @Get(':jobId/preview')
  preview(
    @CurrentScope() scope: ScopeContext,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Promise<ChecklistImportPreview> {
    return this.imports.preview(scope, jobId);
  }

  /**
   * The annotated workbook.
   *
   * Streamed from the API rather than handed over as a presigned link: it is a few
   * kilobytes, it is Super Admin only, and a link would outlive the scope check that
   * produced it.
   */
  @RequirePermission('checklist_import', 'preview')
  @Scope({ param: 'jobId', intent: 'read' })
  @Get(':jobId/error-report')
  async errorReport(
    @CurrentScope() scope: ScopeContext,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const bytes = await this.imports.errorReportBytes(scope, jobId);
    void reply
      .header(
        'content-type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      )
      .header('content-disposition', `attachment; filename="import-${jobId}-errors.xlsx"`)
      .send(bytes);
  }

  @RequirePermission('checklist_import', 'commit')
  @Scope({ param: 'jobId', intent: 'write' })
  @Post(':jobId/commit')
  commit(
    @CurrentScope() scope: ScopeContext,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body(new ZodValidationPipe(commitChecklistImportRequestSchema))
    body: CommitChecklistImportRequest,
  ): Promise<CommitChecklistImportResponse> {
    return this.imports.commit(scope, jobId, body);
  }
}
