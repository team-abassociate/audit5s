import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  cancelAuditAssignmentRequestSchema,
  createAuditAssignmentRequestSchema,
  listAuditAssignmentsQuerySchema,
  type AuditAssignment,
  type CancelAuditAssignmentRequest,
  type CreateAuditAssignmentRequest,
  type Page,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { AssignmentsService } from './assignments.service';

/**
 * Audit assignments (PART 13's `audit-assignments/` module).
 *
 * One parameter name per position, as the router requires: everything addressing a single
 * assignment uses `:assignmentId`. Fastify reports a node by position, so a second name on
 * the same position would make the route print as `:id|:assignmentId` — which the
 * authorization suite's completeness check reads as a route it has no entry for.
 */
@Controller('audit-assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @RequirePermission('audit_assignment', 'create')
  @Scope({ intent: 'write' })
  @Post()
  create(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(createAuditAssignmentRequestSchema))
    body: CreateAuditAssignmentRequest,
  ): Promise<AuditAssignment> {
    return this.assignments.create(scope, body);
  }

  @RequirePermission('audit_assignment', 'read')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listAuditAssignmentsQuerySchema))
    query: ReturnType<typeof listAuditAssignmentsQuerySchema.parse>,
  ): Promise<Page<AuditAssignment>> {
    return this.assignments.list(scope, query);
  }

  @RequirePermission('audit_assignment', 'read')
  @Scope({ param: 'assignmentId', intent: 'read' })
  @Get(':assignmentId')
  get(
    @CurrentScope() scope: ScopeContext,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ): Promise<AuditAssignment> {
    return this.assignments.get(scope, assignmentId);
  }

  /** Cancels; never deletes. The record of what was asked for outlives the asking. */
  @RequirePermission('audit_assignment', 'cancel')
  @Scope({ param: 'assignmentId', intent: 'write' })
  @Post(':assignmentId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentScope() scope: ScopeContext,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body(new ZodValidationPipe(cancelAuditAssignmentRequestSchema))
    body: CancelAuditAssignmentRequest,
  ): Promise<AuditAssignment> {
    return this.assignments.cancel(scope, assignmentId, body);
  }
}
