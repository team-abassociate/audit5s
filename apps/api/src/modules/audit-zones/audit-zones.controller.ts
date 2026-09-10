import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import {
  completeAuditZoneRequestSchema,
  upsertAuditZoneRequestSchema,
  type AuditZone,
  type CompleteAuditZoneRequest,
  type UpsertAuditZoneRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { AuditZonesService } from './audit-zones.service';

/**
 * Audit Zones, addressed under their audit (§8.6).
 *
 * `:auditId` matches the name every other route under `/audits` uses: Fastify identifies a
 * node by position, so a second name on the first position would make the router report
 * `:id|:auditId` and the authorization completeness check would see an unknown route.
 */
@Controller('audits/:auditId/zones')
export class AuditZonesController {
  constructor(private readonly zones: AuditZonesService) {}

  /**
   * The upsert on a client-generated UUIDv7 (D12). The D6 snapshots are taken here, on the
   * insert, and never rewritten — which is what makes editing a Zone afterwards harmless.
   */
  @RequirePermission('audit_zone', 'update')
  @Scope({ param: 'auditId', intent: 'write' })
  @Put(':auditZoneId')
  upsert(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Param('auditZoneId', ParseUUIDPipe) auditZoneId: string,
    @Body(new ZodValidationPipe(upsertAuditZoneRequestSchema)) body: UpsertAuditZoneRequest,
  ): Promise<AuditZone> {
    return this.zones.upsert(scope, auditId, auditZoneId, body);
  }

  @RequirePermission('audit_zone', 'complete')
  @Scope({ param: 'auditId', intent: 'write' })
  @Post(':auditZoneId/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Param('auditZoneId', ParseUUIDPipe) auditZoneId: string,
    @Body(new ZodValidationPipe(completeAuditZoneRequestSchema)) body: CompleteAuditZoneRequest,
  ): Promise<AuditZone> {
    return this.zones.complete(scope, auditId, auditZoneId, body);
  }
}
