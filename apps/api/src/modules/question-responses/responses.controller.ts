import { Body, Controller, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import {
  upsertQuestionResponseRequestSchema,
  type QuestionResponse,
  type UpsertQuestionResponseRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { ResponsesService } from './responses.service';

/**
 * `PUT /audit-zones/{auditZoneId}/responses/{responseId}` (§8.6).
 *
 * A top-level `/audit-zones` tree rather than a third level under `/audits`: the device
 * addresses a response by the Zone it belongs to and the id it generated for it, and the
 * unique index on `(audit_zone_id, checklist_question_id)` makes the write idempotent
 * without the audit id having to travel with every one of the fifty calls.
 */
@Controller('audit-zones/:auditZoneId/responses')
export class ResponsesController {
  constructor(private readonly responses: ResponsesService) {}

  @RequirePermission('question_response', 'upsert')
  @Scope({ param: 'auditZoneId', intent: 'write' })
  @Put(':responseId')
  upsert(
    @CurrentScope() scope: ScopeContext,
    @Param('auditZoneId', ParseUUIDPipe) auditZoneId: string,
    @Param('responseId', ParseUUIDPipe) responseId: string,
    @Body(new ZodValidationPipe(upsertQuestionResponseRequestSchema))
    body: UpsertQuestionResponseRequest,
  ): Promise<QuestionResponse> {
    return this.responses.upsert(scope, auditZoneId, responseId, body);
  }
}
