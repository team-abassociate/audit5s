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
  assignZoneLeaderRequestSchema,
  createZoneRequestSchema,
  listZonesQuerySchema,
  updateZoneRequestSchema,
  type AssignZoneLeaderRequest,
  type CreateZoneRequest,
  type Page,
  type UpdateZoneRequest,
  type Zone,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { ZonesService } from './zones.service';

/**
 * Zones (§8.4). Creation and listing hang off the Unit; everything addressing one Zone is
 * a top-level `/zones/{id}` route, as the API table specifies.
 *
 * The Unit-scoped routes use `:id`, not `:unitId`: Fastify has one parameter *position*
 * under `/units`, and giving it a second name would make the router report the node as
 * `:id|:unitId` — which the authorization suite's completeness check reads as a route it
 * has no entry for.
 */
@Controller()
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  @RequirePermission('zone', 'create')
  @Scope({ intent: 'write' })
  @Post('units/:id/zones')
  create(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) unitId: string,
    @Body(new ZodValidationPipe(createZoneRequestSchema)) body: CreateZoneRequest,
  ): Promise<Zone> {
    return this.zones.create(scope, unitId, body);
  }

  /** `?active=true` by default — this is the Zone dropdown source. */
  @RequirePermission('zone', 'read')
  @Scope({ param: 'id', intent: 'read' })
  @Get('units/:id/zones')
  listForUnit(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) unitId: string,
    @Query(new ZodValidationPipe(listZonesQuerySchema))
    query: ReturnType<typeof listZonesQuerySchema.parse>,
  ): Promise<Page<Zone>> {
    return this.zones.list(scope, query, unitId);
  }

  @RequirePermission('zone', 'read')
  @Scope({ intent: 'read' })
  @Get('zones')
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listZonesQuerySchema))
    query: ReturnType<typeof listZonesQuerySchema.parse>,
  ): Promise<Page<Zone>> {
    return this.zones.list(scope, query);
  }

  @RequirePermission('zone', 'read')
  @Scope({ param: 'id', intent: 'read' })
  @Get('zones/:id')
  get(@CurrentScope() scope: ScopeContext, @Param('id', ParseUUIDPipe) id: string): Promise<Zone> {
    return this.zones.get(scope, id);
  }

  /** Editing a description never touches history — that is the snapshot's job (D6). */
  @RequirePermission('zone', 'update')
  @Scope({ param: 'id', intent: 'write' })
  @Patch('zones/:id')
  update(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateZoneRequestSchema)) body: UpdateZoneRequest,
  ): Promise<Zone> {
    return this.zones.update(scope, id, body);
  }

  @RequirePermission('zone', 'assign_leader')
  @Scope({ param: 'id', intent: 'write' })
  @Post('zones/:id/leader')
  @HttpCode(HttpStatus.OK)
  assignLeader(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(assignZoneLeaderRequestSchema)) body: AssignZoneLeaderRequest,
  ): Promise<Zone> {
    return this.zones.assignLeader(scope, id, body);
  }

  @RequirePermission('zone', 'archive')
  @Scope({ param: 'id', intent: 'write' })
  @Post('zones/:id/archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.zones.archive(scope, id);
  }
}
