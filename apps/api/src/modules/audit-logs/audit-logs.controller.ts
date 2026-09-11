import { Controller, Get, Query } from '@nestjs/common';
import {
  listAuditLogQuerySchema,
  type AuditLogAction,
  type AuditLogEntry,
  type Page,
  type Role,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { AuditLogsRepository } from './audit-logs.repository';

/** The audit-log viewer. SUPER_ADMIN only (PART 6.3), read-only by construction (AL-1). */
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly repository: AuditLogsRepository) {}

  @RequirePermission('audit_log', 'read')
  @Scope({ intent: 'read' })
  @Get()
  async list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listAuditLogQuerySchema))
    query: ReturnType<typeof listAuditLogQuerySchema.parse>,
  ): Promise<Page<AuditLogEntry>> {
    const rows = await this.repository.list(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      data: page.map((row) => ({
        id: String(row.id),
        actorUserId: row.actorUserId,
        actorRole: (row.actorRole as Role | null) ?? null,
        actorLabel: row.actorLabel,
        action: row.action as AuditLogAction,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        unitId: row.unitId,
        before: row.before ?? null,
        after: row.after ?? null,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        deviceId: row.deviceId,
        requestId: row.requestId,
        occurredAt: row.occurredAt.toISOString(),
      })),
      nextCursor: hasMore ? String(page.at(-1)?.id ?? '') || null : null,
    };
  }
}
