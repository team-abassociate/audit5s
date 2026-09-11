import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  commitEvidenceRequestSchema,
  listEvidenceQuerySchema,
  patchEvidenceRequestSchema,
  uploadIntentRequestSchema,
  type CommitEvidenceRequest,
  type Evidence,
  type EvidenceViewUrl,
  type ListEvidenceQuery,
  type Page,
  type PatchEvidenceRequest,
  type UploadIntentRequest,
  type UploadIntentResponse,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { EvidenceService } from './evidence.service';

/**
 * The evidence surface (§8.7).
 *
 * `:evidenceId` is the name for this parameter position everywhere it appears. Fastify
 * identifies a route node by *position*, not by name, so a second name on the first
 * position under `/evidence` would make the router report `:id|:evidenceId` and the
 * authorization completeness check would see a route it has no entry for.
 */
@Controller('evidence')
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  /**
   * Phase one of §9.4. Creates the metadata row and hands back a presigned PUT; the bytes
   * go straight to storage and never through here (§5).
   */
  @RequirePermission('evidence', 'create')
  @Scope({ intent: 'write' })
  @Post('upload-intent')
  @HttpCode(HttpStatus.CREATED)
  createUploadIntent(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(uploadIntentRequestSchema)) body: UploadIntentRequest,
  ): Promise<UploadIntentResponse> {
    return this.evidence.createUploadIntent(scope, body);
  }

  /**
   * Phase two. The server HEADs the object, verifies size and checksum, sniffs the magic
   * bytes (§12.8) and derives the classification (E-1). Replaying it is §9.6's recovery
   * path for an app killed between the PUT and the confirmation, so it returns the same
   * body rather than raising.
   */
  @RequirePermission('evidence', 'create')
  @Scope({ param: 'evidenceId', intent: 'write' })
  @Post(':evidenceId/commit')
  @HttpCode(HttpStatus.OK)
  commit(
    @CurrentScope() scope: ScopeContext,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body(new ZodValidationPipe(commitEvidenceRequestSchema)) body: CommitEvidenceRequest,
  ): Promise<Evidence> {
    return this.evidence.commit(scope, evidenceId, body);
  }

  @RequirePermission('evidence', 'read')
  @Scope({ param: 'evidenceId', intent: 'read' })
  @Get(':evidenceId')
  get(
    @CurrentScope() scope: ScopeContext,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
  ): Promise<Evidence> {
    return this.evidence.get(scope, evidenceId);
  }

  /** §12.6: a ≤5-minute presigned GET, minted **after** the scope check. */
  @RequirePermission('evidence', 'view_url')
  @Scope({ param: 'evidenceId', intent: 'read' })
  @Get(':evidenceId/view-url')
  viewUrl(
    @CurrentScope() scope: ScopeContext,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
  ): Promise<EvidenceViewUrl> {
    return this.evidence.viewUrl(scope, evidenceId);
  }

  /** The remark and the summary flag. A flag clash is `409 SUMMARY_FLAG_TAKEN`. */
  @RequirePermission('evidence', 'set_summary_flag')
  @Scope({ param: 'evidenceId', intent: 'write' })
  @Patch(':evidenceId')
  patch(
    @CurrentScope() scope: ScopeContext,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body(new ZodValidationPipe(patchEvidenceRequestSchema)) body: PatchEvidenceRequest,
  ): Promise<Evidence> {
    return this.evidence.patch(scope, evidenceId, body);
  }

  /** E-4: a soft delete, and `409` once the audit is completed. */
  @RequirePermission('evidence', 'soft_delete')
  @Scope({ param: 'evidenceId', intent: 'write' })
  @Delete(':evidenceId')
  @HttpCode(HttpStatus.OK)
  softDelete(
    @CurrentScope() scope: ScopeContext,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
  ): Promise<Evidence> {
    return this.evidence.softDelete(scope, evidenceId);
  }
}

/**
 * The Zone's gallery (§8.7).
 *
 * Under `/audit-zones/:auditZoneId`, matching the name Phase 3 settled on for that
 * position — the response upsert uses it too.
 */
@Controller('audit-zones/:auditZoneId/evidence')
export class AuditZoneEvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  @RequirePermission('evidence', 'read')
  @Scope({ param: 'auditZoneId', intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Param('auditZoneId', ParseUUIDPipe) auditZoneId: string,
    @Query(new ZodValidationPipe(listEvidenceQuerySchema)) query: ListEvidenceQuery,
  ): Promise<Page<Evidence>> {
    return this.evidence.listForZone(scope, auditZoneId, query);
  }
}
