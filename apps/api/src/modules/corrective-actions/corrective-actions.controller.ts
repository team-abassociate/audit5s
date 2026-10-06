import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  HEADER_IDEMPOTENCY_KEY,
  correctiveActionSummaryQuerySchema,
  listCorrectiveActionsQuerySchema,
  reassignCorrectiveActionRequestSchema,
  reopenCorrectiveActionRequestSchema,
  submitCorrectiveActionRequestSchema,
  verifyCorrectiveActionRequestSchema,
  type CorrectiveAction,
  type CorrectiveActionDetail,
  type CorrectiveActionLink,
  type CorrectiveActionSubmission,
  type CorrectiveActionSummary,
  type CorrectiveActionSummaryQuery,
  type ListCorrectiveActionsQuery,
  type Page,
  type ReassignCorrectiveActionRequest,
  type ReopenCorrectiveActionRequest,
  type SubmitCorrectiveActionRequest,
  type VerifyCorrectiveActionRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { OmitOnReplay } from '../../common/idempotency/idempotency.interceptor';
import { ReportTokensService } from '../reports/report-tokens.service';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { CorrectiveActionsService } from './corrective-actions.service';

/**
 * Corrective actions (§8.8). `:correctiveActionId` is the one name for this position, for
 * the same router reason every other controller gives.
 */
@Controller('corrective-actions')
export class CorrectiveActionsController {
  constructor(
    private readonly actions: CorrectiveActionsService,
    private readonly tokens: ReportTokensService,
  ) {}

  @RequirePermission('corrective_action', 'read')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listCorrectiveActionsQuerySchema)) query: ListCorrectiveActionsQuery,
  ): Promise<Page<CorrectiveAction>> {
    return this.actions.list(scope, query);
  }

  /** CA10: the list's counts, so a screen never counts the rows it happens to have loaded. */
  @RequirePermission('corrective_action', 'read')
  @Scope({ intent: 'read' })
  @Get('summary')
  summary(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(correctiveActionSummaryQuerySchema)) query: CorrectiveActionSummaryQuery,
  ): Promise<CorrectiveActionSummary> {
    return this.actions.summary(scope, query);
  }

  /**
   * CA9: one more link to this action, for a Super Admin or the Unit's Coordinator (R-47)
   * to copy or resend. The link the PDF printed keeps working — a link is only ever ended by
   * revoking it (R-41). The raw secret is in this response once and never stored, not even
   * for a replay.
   */
  @RequirePermission('corrective_action', 'link')
  @Scope({ param: 'correctiveActionId', intent: 'write' })
  @Post(':correctiveActionId/link')
  @HttpCode(HttpStatus.CREATED)
  @OmitOnReplay('url')
  link(
    @CurrentScope() scope: ScopeContext,
    @Param('correctiveActionId', ParseUUIDPipe) actionId: string,
    @Headers(HEADER_IDEMPOTENCY_KEY) idempotencyKey: string | undefined,
  ): Promise<CorrectiveActionLink> {
    if (!idempotencyKey) {
      throw AppError.validation('This request needs an Idempotency-Key header', [
        { field: HEADER_IDEMPOTENCY_KEY, message: 'Required' },
      ]);
    }
    return this.tokens.mintForAction(scope, actionId);
  }

  @RequirePermission('corrective_action', 'read')
  @Scope({ param: 'correctiveActionId', intent: 'read' })
  @Get(':correctiveActionId')
  get(
    @CurrentScope() scope: ScopeContext,
    @Param('correctiveActionId', ParseUUIDPipe) actionId: string,
  ): Promise<CorrectiveActionDetail> {
    return this.actions.get(scope, actionId);
  }

  /**
   * "Idempotency-Key required" (§8.8): the one POST whose retry must never become
   * `attempt_no + 1`. The interceptor replays the stored response; this makes sure there is
   * a key to replay it by.
   */
  @RequirePermission('corrective_action', 'submit')
  @Scope({ param: 'correctiveActionId', intent: 'write' })
  @Post(':correctiveActionId/submissions')
  @HttpCode(HttpStatus.CREATED)
  submit(
    @CurrentScope() scope: ScopeContext,
    @Param('correctiveActionId', ParseUUIDPipe) actionId: string,
    @Headers(HEADER_IDEMPOTENCY_KEY) idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(submitCorrectiveActionRequestSchema)) body: SubmitCorrectiveActionRequest,
  ): Promise<CorrectiveActionSubmission> {
    if (!idempotencyKey) {
      throw AppError.validation('This request needs an Idempotency-Key header', [
        { field: HEADER_IDEMPOTENCY_KEY, message: 'Required (§8.8)' },
      ]);
    }
    return this.actions.submit(scope, actionId, body, scope.actor.deviceId ? 'MOBILE' : 'WEB_SESSION');
  }

  @RequirePermission('corrective_action', 'verify')
  @Scope({ param: 'correctiveActionId', intent: 'write' })
  @Post(':correctiveActionId/verify')
  @HttpCode(HttpStatus.OK)
  verify(
    @CurrentScope() scope: ScopeContext,
    @Param('correctiveActionId', ParseUUIDPipe) actionId: string,
    @Body(new ZodValidationPipe(verifyCorrectiveActionRequestSchema)) body: VerifyCorrectiveActionRequest,
  ): Promise<CorrectiveActionDetail> {
    return this.actions.verify(scope, actionId, body);
  }

  @RequirePermission('corrective_action', 'reopen')
  @Scope({ param: 'correctiveActionId', intent: 'write' })
  @Post(':correctiveActionId/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @CurrentScope() scope: ScopeContext,
    @Param('correctiveActionId', ParseUUIDPipe) actionId: string,
    @Body(new ZodValidationPipe(reopenCorrectiveActionRequestSchema)) body: ReopenCorrectiveActionRequest,
  ): Promise<CorrectiveActionDetail> {
    return this.actions.reopen(scope, actionId, body);
  }

  @RequirePermission('corrective_action', 'reassign')
  @Scope({ param: 'correctiveActionId', intent: 'write' })
  @Post(':correctiveActionId/reassign')
  @HttpCode(HttpStatus.OK)
  reassign(
    @CurrentScope() scope: ScopeContext,
    @Param('correctiveActionId', ParseUUIDPipe) actionId: string,
    @Body(new ZodValidationPipe(reassignCorrectiveActionRequestSchema)) body: ReassignCorrectiveActionRequest,
  ): Promise<CorrectiveActionDetail> {
    return this.actions.reassign(scope, actionId, body);
  }
}
