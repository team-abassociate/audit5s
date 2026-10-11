import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  HEADER_IDEMPOTENCY_KEY,
  commitKaizenPhotoRequestSchema,
  createKaizenRequestSchema,
  kaizenAnalysisQuerySchema,
  kaizenDashboardQuerySchema,
  kaizenPhotoUploadIntentRequestSchema,
  listKaizensQuerySchema,
  patchKaizenRequestSchema,
  reviewKaizenRequestSchema,
  submitKaizenRequestSchema,
  type CommitKaizenPhotoRequest,
  type CreateKaizenRequest,
  type Kaizen,
  type KaizenAnalysis,
  type KaizenAnalysisQuery,
  type KaizenDashboard,
  type KaizenDashboardQuery,
  type KaizenDetail,
  type KaizenExport,
  type KaizenPhoto,
  type KaizenPhotoUploadIntentRequest,
  type KaizenPhotoUploadIntentResponse,
  type ListKaizensQuery,
  type Page,
  type PatchKaizenRequest,
  type ReviewKaizenRequest,
  type SubmitKaizenRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { KaizensService } from './kaizens.service';

/**
 * Kaizens (R-48, plans/kaizen-module.md §4.5). `:kaizenId` is the one name for this
 * position. The static routes (`dashboard`, `analysis`) are declared before it.
 */
@Controller('kaizens')
export class KaizensController {
  constructor(private readonly kaizens: KaizensService) {}

  @RequirePermission('kaizen', 'read')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listKaizensQuerySchema)) query: ListKaizensQuery,
  ): Promise<Page<Kaizen>> {
    return this.kaizens.list(scope, query);
  }

  /** §4.7: every number on the four visuals, counted by `packages/domain`. */
  @RequirePermission('kaizen', 'read')
  @Scope({ intent: 'read' })
  @Get('dashboard')
  dashboard(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(kaizenDashboardQuerySchema)) query: KaizenDashboardQuery,
  ): Promise<KaizenDashboard> {
    return this.kaizens.dashboard(scope, query);
  }

  @RequirePermission('kaizen', 'read')
  @Scope({ intent: 'read' })
  @Get('analysis')
  analysis(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(kaizenAnalysisQuerySchema)) query: KaizenAnalysisQuery,
  ): Promise<KaizenAnalysis> {
    return this.kaizens.analysis(scope, query);
  }

  @RequirePermission('kaizen', 'read')
  @Scope({ param: 'kaizenId', intent: 'read' })
  @Get(':kaizenId')
  get(
    @CurrentScope() scope: ScopeContext,
    @Param('kaizenId', ParseUUIDPipe) kaizenId: string,
  ): Promise<KaizenDetail> {
    return this.kaizens.get(scope, kaizenId);
  }

  /** Idempotent on the device-minted `id`: a replay returns the same Kaizen and number. */
  @RequirePermission('kaizen', 'create')
  @Scope({ intent: 'write' })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(createKaizenRequestSchema)) body: CreateKaizenRequest,
  ): Promise<KaizenDetail> {
    return this.kaizens.create(scope, body);
  }

  @RequirePermission('kaizen', 'create')
  @Scope({ param: 'kaizenId', intent: 'write' })
  @Patch(':kaizenId')
  patch(
    @CurrentScope() scope: ScopeContext,
    @Param('kaizenId', ParseUUIDPipe) kaizenId: string,
    @Body(new ZodValidationPipe(patchKaizenRequestSchema)) body: PatchKaizenRequest,
  ): Promise<KaizenDetail> {
    return this.kaizens.patch(scope, kaizenId, body);
  }

  /** Idempotent on `submissionId`, which the device mints when Submit is tapped. */
  @RequirePermission('kaizen', 'create')
  @Scope({ param: 'kaizenId', intent: 'write' })
  @Post(':kaizenId/submit')
  @HttpCode(HttpStatus.OK)
  submit(
    @CurrentScope() scope: ScopeContext,
    @Param('kaizenId', ParseUUIDPipe) kaizenId: string,
    @Body(new ZodValidationPipe(submitKaizenRequestSchema)) body: SubmitKaizenRequest,
  ): Promise<KaizenDetail> {
    return this.kaizens.submit(scope, kaizenId, body);
  }

  /**
   * The author deletes their own DRAFT (R-49): soft, it leaves every list. Idempotency-Key
   * required, as for a review: the body carries no id. Already discarded ⇒ 204 all the same.
   */
  @RequirePermission('kaizen', 'create')
  @Scope({ param: 'kaizenId', intent: 'write' })
  @Post(':kaizenId/discard')
  @HttpCode(HttpStatus.NO_CONTENT)
  discard(
    @CurrentScope() scope: ScopeContext,
    @Param('kaizenId', ParseUUIDPipe) kaizenId: string,
    @Headers(HEADER_IDEMPOTENCY_KEY) idempotencyKey: string | undefined,
  ): Promise<void> {
    if (!idempotencyKey) {
      throw AppError.validation('This request needs an Idempotency-Key header', [
        { field: HEADER_IDEMPOTENCY_KEY, message: 'Required' },
      ]);
    }
    return this.kaizens.discard(scope, kaizenId);
  }

  /**
   * Approve, send back or reject. Idempotency-Key required: the body carries no id of its
   * own, so a retried approval is told apart from a second decision only by the key.
   */
  @RequirePermission('kaizen', 'review')
  @Scope({ param: 'kaizenId', intent: 'write' })
  @Post(':kaizenId/review')
  @HttpCode(HttpStatus.OK)
  review(
    @CurrentScope() scope: ScopeContext,
    @Param('kaizenId', ParseUUIDPipe) kaizenId: string,
    @Headers(HEADER_IDEMPOTENCY_KEY) idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(reviewKaizenRequestSchema)) body: ReviewKaizenRequest,
  ): Promise<KaizenDetail> {
    if (!idempotencyKey) {
      throw AppError.validation('This request needs an Idempotency-Key header', [
        { field: HEADER_IDEMPOTENCY_KEY, message: 'Required' },
      ]);
    }
    return this.kaizens.review(scope, kaizenId, body);
  }

  /** §4.6: queues the Kaizen Sheet and answers 202; poll the export for its download. */
  @RequirePermission('kaizen', 'read')
  @Scope({ param: 'kaizenId', intent: 'read' })
  @Post(':kaizenId/export')
  @HttpCode(HttpStatus.ACCEPTED)
  requestExport(
    @CurrentScope() scope: ScopeContext,
    @Param('kaizenId', ParseUUIDPipe) kaizenId: string,
  ): Promise<KaizenExport> {
    return this.kaizens.requestExport(scope, kaizenId);
  }

  /** A short-TTL presigned GET once READY (§12.6), minted after the scope check. */
  @RequirePermission('kaizen', 'read')
  @Scope({ param: 'kaizenId', intent: 'read' })
  @Get(':kaizenId/export/:exportId')
  exportStatus(
    @CurrentScope() scope: ScopeContext,
    @Param('kaizenId', ParseUUIDPipe) kaizenId: string,
    @Param('exportId', ParseUUIDPipe) exportId: string,
  ): Promise<KaizenExport> {
    return this.kaizens.exportStatus(scope, kaizenId, exportId);
  }

  @RequirePermission('kaizen', 'create')
  @Scope({ param: 'kaizenId', intent: 'write' })
  @Post(':kaizenId/photos/upload-intent')
  @HttpCode(HttpStatus.CREATED)
  photoIntent(
    @CurrentScope() scope: ScopeContext,
    @Param('kaizenId', ParseUUIDPipe) kaizenId: string,
    @Body(new ZodValidationPipe(kaizenPhotoUploadIntentRequestSchema)) body: KaizenPhotoUploadIntentRequest,
  ): Promise<KaizenPhotoUploadIntentResponse> {
    if (body.kaizenId !== kaizenId) {
      throw AppError.validation('The body names a different Kaizen from the path', [
        { field: 'kaizenId', message: 'Must match the path' },
      ]);
    }
    return this.kaizens.createPhotoIntent(scope, body);
  }

  @RequirePermission('kaizen', 'create')
  @Scope({ param: 'kaizenId', intent: 'write' })
  @Post(':kaizenId/photos/:photoId/commit')
  @HttpCode(HttpStatus.OK)
  commitPhoto(
    @CurrentScope() scope: ScopeContext,
    @Param('kaizenId', ParseUUIDPipe) kaizenId: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @Body(new ZodValidationPipe(commitKaizenPhotoRequestSchema)) body: CommitKaizenPhotoRequest,
  ): Promise<KaizenPhoto> {
    return this.kaizens.commitPhoto(scope, kaizenId, photoId, body);
  }

  @RequirePermission('kaizen', 'create')
  @Scope({ param: 'kaizenId', intent: 'write' })
  @Delete(':kaizenId/photos/:photoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removePhoto(
    @CurrentScope() scope: ScopeContext,
    @Param('kaizenId', ParseUUIDPipe) kaizenId: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
  ): Promise<void> {
    return this.kaizens.removePhoto(scope, kaizenId, photoId);
  }
}
