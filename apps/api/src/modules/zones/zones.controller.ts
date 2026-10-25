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
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
// The type augmentation that puts `request.file()` on FastifyRequest.
import '@fastify/multipart';
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
  type ZoneListImportResult,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { AppError } from '../../common/errors';
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

  /**
   * R-59: the Unit's Zone list from an Excel or PDF file, as a multipart field `file`.
   * Replaces the list — Super Admin and Coordinator only, as creating a Zone is.
   */
  @RequirePermission('zone', 'create')
  @Scope({ intent: 'write' })
  @Post('units/:id/zones/import')
  @HttpCode(HttpStatus.OK)
  async importList(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) unitId: string,
    @Req() request: FastifyRequest,
  ): Promise<ZoneListImportResult> {
    const file = await request.file();
    if (!file) {
      throw AppError.validation('Send the Zone list as a multipart file field named `file`');
    }
    return this.zones.importList(scope, unitId, await file.toBuffer());
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
