import {
  Body,
  Controller,
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
  cancelAuditRequestSchema,
  completeAuditRequestSchema,
  createAuditRequestSchema,
  listAuditsQuerySchema,
  pauseAuditRequestSchema,
  postCompletionOverrideRequestSchema,
  resumeAuditRequestSchema,
  startAuditRequestSchema,
  type Audit,
  type AuditDetail,
  type AuditScoreSummary,
  type CancelAuditRequest,
  type CompleteAuditRequest,
  type CreateAuditRequest,
  type Page,
  type PauseAuditRequest,
  type PostCompletionOverrideRequest,
  type ResumeAuditRequest,
  type StartAuditRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import {
  RequirePermission,
  RequirePermissionFor,
  Scope,
  type PermissionRequirement,
} from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { AuditsService } from './audits.service';

/** Every PART 6 cell `POST /audits` can consult, listed so a reader need not run the selector. */
export const AUDIT_CREATE_PERMISSIONS: readonly PermissionRequirement[] = [
  { resource: 'audit', action: 'create_external' },
  { resource: 'audit', action: 'create_walk_by' },
  { resource: 'audit', action: 'create_cross' },
];

/**
 * `auditType` → the cell that judges it.
 *
 * An unrecognised or missing type falls through to `create_external`, the narrowest of the
 * three: a malformed body must not pick the most permissive cell. The Zod pipe rejects it
 * a moment later anyway, but the guard runs first and has to choose safely.
 */
export function permissionForAuditType(auditType: string | undefined): PermissionRequirement {
  switch (auditType) {
    case 'CROSS_5S':
      return { resource: 'audit', action: 'create_cross' };
    case 'WALK_BY':
      return { resource: 'audit', action: 'create_walk_by' };
    default:
      return { resource: 'audit', action: 'create_external' };
  }
}

/**
 * Audits (§8.6).
 *
 * **One parameter name per position.** Fastify identifies a route node by position, not by
 * name, so `/audits/:id` beside `/audits/:auditId/zones/...` makes the router print
 * `:id|:auditId` — which the authorization suite's completeness check reads as a route it
 * has no entry for. §8.6 spells the nested paths with `:auditId`, so every route under
 * `/audits` uses that name.
 */
@Controller('audits')
export class AuditsController {
  constructor(private readonly audits: AuditsService) {}

  /**
   * §8.6 gives audit creation one endpoint with an `auditType` in the body; PART 6 gives
   * it three cells whose resolvers differ by role. The dynamic requirement below consults
   * the cell the request actually names, through the unchanged guards — a Zone Leader
   * naming `CROSS_5S` is judged by `create_cross`, and one naming `EXTERNAL_5S` is refused
   * by `create_external`, which they hold no grant for.
   */
  @RequirePermissionFor({
    candidates: AUDIT_CREATE_PERMISSIONS,
    select: (body) => permissionForAuditType((body as { auditType?: string })?.auditType),
  })
  @Scope({ intent: 'write' })
  @Post()
  create(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(createAuditRequestSchema)) body: CreateAuditRequest,
  ): Promise<Audit> {
    return this.audits.create(scope, body);
  }

  @RequirePermission('audit', 'read')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listAuditsQuerySchema))
    query: ReturnType<typeof listAuditsQuerySchema.parse>,
  ): Promise<Page<Audit>> {
    return this.audits.list(scope, query);
  }

  @RequirePermission('audit', 'read')
  @Scope({ param: 'auditId', intent: 'read' })
  @Get(':auditId')
  get(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
  ): Promise<AuditDetail> {
    return this.audits.detail(scope, auditId);
  }

  /** The Consultant's read model (N6). Not an official report — that is `/reports`. */
  @RequirePermission('report', 'score_summary')
  @Scope({ param: 'auditId', intent: 'read' })
  @Get(':auditId/summary')
  summary(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
  ): Promise<AuditScoreSummary> {
    return this.audits.summary(scope, auditId);
  }

  @RequirePermission('audit', 'update')
  @Scope({ param: 'auditId', intent: 'write' })
  @Post(':auditId/start')
  @HttpCode(HttpStatus.OK)
  start(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Body(new ZodValidationPipe(startAuditRequestSchema)) body: StartAuditRequest,
  ): Promise<Audit> {
    return this.audits.start(scope, auditId, body);
  }

  /** Abort (N7): save + pause + notify + resume. Nothing is discarded, ever. */
  @RequirePermission('audit', 'pause')
  @Scope({ param: 'auditId', intent: 'write' })
  @Post(':auditId/pause')
  @HttpCode(HttpStatus.OK)
  pause(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Body(new ZodValidationPipe(pauseAuditRequestSchema)) body: PauseAuditRequest,
  ): Promise<Audit> {
    return this.audits.pause(scope, auditId, body);
  }

  @RequirePermission('audit', 'resume')
  @Scope({ param: 'auditId', intent: 'write' })
  @Post(':auditId/resume')
  @HttpCode(HttpStatus.OK)
  resume(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Body(new ZodValidationPipe(resumeAuditRequestSchema)) body: ResumeAuditRequest,
  ): Promise<Audit> {
    return this.audits.resume(scope, auditId, body);
  }

  @RequirePermission('audit', 'complete')
  @Scope({ param: 'auditId', intent: 'write' })
  @Post(':auditId/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Body(new ZodValidationPipe(completeAuditRequestSchema)) body: CompleteAuditRequest,
  ): Promise<Audit> {
    return this.audits.complete(scope, auditId, body);
  }

  /** Voids the audit and keeps every row (A-1). There is no DELETE here, for anybody. */
  @RequirePermission('audit', 'cancel')
  @Scope({ param: 'auditId', intent: 'write' })
  @Post(':auditId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Body(new ZodValidationPipe(cancelAuditRequestSchema)) body: CancelAuditRequest,
  ): Promise<Audit> {
    return this.audits.cancel(scope, auditId, body);
  }

  /** A-2's only door. Writes `audit.changed_after_completion` with before and after. */
  @RequirePermission('audit', 'edit_after_completion')
  @Scope({ param: 'auditId', intent: 'write' })
  @Patch(':auditId/post-completion')
  postCompletion(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Body(new ZodValidationPipe(postCompletionOverrideRequestSchema))
    body: PostCompletionOverrideRequest,
  ): Promise<AuditDetail> {
    return this.audits.postCompletionOverride(scope, auditId, body);
  }
}
