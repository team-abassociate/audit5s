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
  callCrossAuditRequestSchema,
  createUnitRequestSchema,
  listUnitsQuerySchema,
  updateUnitRequestSchema,
  type CallCrossAuditRequest,
  type CreateUnitRequest,
  type CrossAuditCall,
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
    return this.units.callCrossAudit(scope, id, body.zoneId, body.dueOn);
  }

  /** The Unit's cross-audit calls still standing (0050): the Zone Leaders' blue list. */
  @RequirePermission('unit', 'read')
  @Scope({ param: 'id', intent: 'read' })
  @Get(':id/cross-audit-calls')
  listCrossAuditCalls(@CurrentScope() scope: ScopeContext, @Param('id', ParseUUIDPipe) id: string): Promise<CrossAuditCall[]> {
    return this.units.listCrossAuditCalls(scope, id);
  }
}
