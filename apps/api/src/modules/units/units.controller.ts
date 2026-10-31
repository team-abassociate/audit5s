import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Post,
  Query,
} from '@nestjs/common';
import {
  callCrossAuditRequestSchema,
  changeCrossAuditDeadlineRequestSchema,
  completeCrossAuditRequestSchema,
  reassignCrossAuditRequestSchema,
  createUnitRequestSchema,
  listUnitsQuerySchema,
  updateUnitRequestSchema,
  type CallCrossAuditRequest,
  type ChangeCrossAuditDeadlineRequest,
  type CompleteCrossAuditRequest,
  type ReassignCrossAuditRequest,
  type CreateUnitRequest,
  type CrossAuditCall,
  type CrossAuditor,
  type CrossAuditRound,
  type Page,
  type Unit,
  type UpdateUnitRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { UnitsService } from './units.service';

@Controller('units')
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @RequirePermission('unit', 'create')
  @Scope({ intent: 'write' })
  @Post()
  create(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(createUnitRequestSchema)) body: CreateUnitRequest,
  ): Promise<Unit> {
    return this.units.create(scope, body);
  }

  @RequirePermission('unit', 'read')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listUnitsQuerySchema)) query: ReturnType<typeof listUnitsQuerySchema.parse>,
  ): Promise<Page<Unit>> {
    return this.units.list(scope, query);
  }

  @RequirePermission('unit', 'read')
  @Scope({ param: 'id', intent: 'read' })
  @Get(':id')
  get(@CurrentScope() scope: ScopeContext, @Param('id', ParseUUIDPipe) id: string): Promise<Unit> {
    return this.units.get(scope, id);
  }

  /**
   * One route, two permissions. A body carrying `name` needs `unit:update_identity`, which
   * only a Super Admin holds; anything else needs `unit:update_profile`. The route declares
   * the profile permission and the service applies the field-level rule, so a Coordinator
   * sending `name` reaches a `FIELD_NOT_EDITABLE` that names the field rather than a bare
   * 403 that does not (U-1).
   */
  @RequirePermission('unit', 'update_profile')
  @Scope({ param: 'id', intent: 'write' })
  @Patch(':id')
  update(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateUnitRequestSchema)) body: UpdateUnitRequest,
  ): Promise<Unit> {
    return this.units.update(scope, id, body);
  }

  @RequirePermission('unit', 'archive')
  @Scope({ param: 'id', intent: 'write' })
  @Post(':id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(@CurrentScope() scope: ScopeContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.units.archive(scope, id);
  }

  /** §2.6: tells every Zone Leader of the Unit to cross-audit the named Zone. Nothing else changes. */
  @RequirePermission('unit', 'call_cross_audit')
  @Scope({ param: 'id', intent: 'write' })
  @Post(':id/cross-audit')
  @HttpCode(HttpStatus.NO_CONTENT)
  callCrossAudit(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(callCrossAuditRequestSchema)) body: CallCrossAuditRequest,
  ): Promise<void> {
    const requested = body.assignments ?? (body.zoneIds ?? [body.zoneId!]).map((zoneId) => ({ zoneId }));
    return this.units.callCrossAudit(scope, id, requested, body.dueOn);
  }

  /** R-73: who the Coordinator may give a Zone of a cross audit to — the Unit's Zone Leaders. */
  @RequirePermission('unit', 'call_cross_audit')
  @Scope({ param: 'id', intent: 'read' })
  @Get(':id/cross-auditors')
  listCrossAuditors(@CurrentScope() scope: ScopeContext, @Param('id', ParseUUIDPipe) id: string): Promise<CrossAuditor[]> {
    return this.units.listCrossAuditors(scope, id);
  }

  /** R-73: gives one Zone of a called cross audit to someone else. */
  @RequirePermission('unit', 'call_cross_audit')
  @Scope({ param: 'id', intent: 'write' })
  @Put(':id/cross-audits/:roundId/zones/:zoneId/assignee')
  @HttpCode(HttpStatus.NO_CONTENT)
  reassignCrossAudit(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('roundId', ParseUUIDPipe) roundId: string,
    @Param('zoneId', ParseUUIDPipe) zoneId: string,
    @Body(new ZodValidationPipe(reassignCrossAuditRequestSchema)) body: ReassignCrossAuditRequest,
  ): Promise<void> {
    return this.units.reassignCrossAudit(scope, id, roundId, zoneId, body.auditorUserId);
  }

  /** The Unit's cross-audit calls still standing (0050): the Zone Leaders' blue list. */
  @RequirePermission('unit', 'read')
  @Scope({ param: 'id', intent: 'read' })
  @Get(':id/cross-audit-calls')
  listCrossAuditCalls(@CurrentScope() scope: ScopeContext, @Param('id', ParseUUIDPipe) id: string): Promise<CrossAuditCall[]> {
    return this.units.listCrossAuditCalls(scope, id);
  }

  /** The Unit's called cross audits, each with where every Zone stands (0051): the Coordinator's card. */
  @RequirePermission('unit', 'read')
  @Scope({ param: 'id', intent: 'read' })
  @Get(':id/cross-audits')
  listCrossAuditRounds(@CurrentScope() scope: ScopeContext, @Param('id', ParseUUIDPipe) id: string): Promise<CrossAuditRound[]> {
    return this.units.listCrossAuditRounds(scope, id);
  }

  /** Moves a called cross audit's deadline: the Zone Leaders could not make it in time (0051). */
  @RequirePermission('unit', 'call_cross_audit')
  @Scope({ param: 'id', intent: 'write' })
  @Patch(':id/cross-audits/:roundId')
  @HttpCode(HttpStatus.NO_CONTENT)
  changeCrossAuditDeadline(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('roundId', ParseUUIDPipe) roundId: string,
    @Body(new ZodValidationPipe(changeCrossAuditDeadlineRequestSchema)) body: ChangeCrossAuditDeadlineRequest,
  ): Promise<void> {
    return this.units.changeCrossAuditDeadline(scope, id, roundId, body.dueOn);
  }

  /** Completes a called cross audit, with a remark when a Zone was left unaudited (0051). */
  @RequirePermission('unit', 'call_cross_audit')
  @Scope({ param: 'id', intent: 'write' })
  @Post(':id/cross-audits/:roundId/complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  completeCrossAudit(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('roundId', ParseUUIDPipe) roundId: string,
    @Body(new ZodValidationPipe(completeCrossAuditRequestSchema)) body: CompleteCrossAuditRequest,
  ): Promise<void> {
    return this.units.completeCrossAudit(scope, id, roundId, body.remark);
  }
}
