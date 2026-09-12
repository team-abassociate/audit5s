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
  listCorrectiveActionsQuerySchema,
  reassignCorrectiveActionRequestSchema,
  reopenCorrectiveActionRequestSchema,
  submitCorrectiveActionRequestSchema,
  verifyCorrectiveActionRequestSchema,
  type CorrectiveAction,
  type CorrectiveActionDetail,
  type CorrectiveActionSubmission,
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
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { CorrectiveActionsService } from './corrective-actions.service';

/**
 * Corrective actions (§8.8). `:correctiveActionId` is the one name for this position, for
 * the same router reason every other controller gives.
 */
@Controller('corrective-actions')
export class CorrectiveActionsController {
  constructor(private readonly actions: CorrectiveActionsService) {}

  @RequirePermission('corrective_action', 'read')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listCorrectiveActionsQuerySchema)) query: ListCorrectiveActionsQuery,
  ): Promise<Page<CorrectiveAction>> {
    return this.actions.list(scope, query);
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
