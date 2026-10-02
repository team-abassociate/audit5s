import { Injectable } from '@nestjs/common';
import type {
  CreateIndustryRequest,
  Industry,
  SetIndustryChecklistsRequest,
  UpdateIndustryRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { isUniqueViolation } from '../../common/pg-errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { IndustriesRepository } from './industries.repository';

type IndustryRow = Awaited<ReturnType<IndustriesRepository['list']>>[number];

@Injectable()
export class IndustriesService {
  constructor(
    private readonly repository: IndustriesRepository,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(scope: ScopeContext, includeArchived: boolean): Promise<Industry[]> {
    return (await this.repository.list(scope, includeArchived)).map(toIndustry);
  }

  async create(scope: ScopeContext, request: CreateIndustryRequest): Promise<Industry> {
    try {
      const created = await this.repository.create(scope, request);
      await this.auditLog.recordSafely(
        { action: 'industry.created', resourceType: 'industry', resourceId: created.id },
        `${created.name} (${created.code})`,
      );
      const row = await this.repository.findById(scope, created.id);
      return toIndustry(row!);
    } catch (error) {
      if (isUniqueViolation(error, 'industry_code_active_key')) {
        throw AppError.conflict(
          'DUPLICATE_CODE',
          `An industry with the code '${request.code}' already exists`,
        );
      }
      throw error;
    }
  }

  async update(
    scope: ScopeContext,
    industryId: string,
    request: UpdateIndustryRequest,
  ): Promise<Industry> {
    const updated = await this.repository.update(scope, industryId, {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.sortOrder !== undefined ? { sortOrder: request.sortOrder } : {}),
    });
    if (!updated) throw AppError.notFound('No such industry');

    await this.auditLog.recordSafely(
      { action: 'industry.updated', resourceType: 'industry', resourceId: industryId },
      updated.name,
    );
    const row = await this.repository.findById(scope, industryId);
    return toIndustry(row!);
  }

  /**
   * Ticks exactly these checklists for this industry (0042). Other industries' ticks are
   * untouched, so one checklist can serve several sectors.
   */
  async setChecklists(
    scope: ScopeContext,
    industryId: string,
    request: SetIndustryChecklistsRequest,
  ): Promise<Industry> {
    const existing = await this.repository.findById(scope, industryId);
    if (!existing || existing.archivedAt !== null) throw AppError.notFound('No such industry');

    const changed = await this.repository.setTemplates(scope, industryId, request.templateIds);
    if (!changed) throw AppError.validation('One of those checklists does not exist');

    if (changed.added.length > 0 || changed.removed.length > 0) {
      await this.auditLog.record({
        action: 'industry.checklists_changed',
        resourceType: 'industry',
        resourceId: industryId,
        after: { added: changed.added, removed: changed.removed },
      });
    }
    const row = await this.repository.findById(scope, industryId);
    return toIndustry(row!);
  }

  /**
   * Archiving, never deleting (D8) — templates and Units point at this row, and a
   * catalogue that can lose its sector label is one nobody can explain later.
   *
   * An industry still in use is refused rather than archived quietly. Archiving one that
   * six templates depend on would leave those templates labelled with something no screen
   * lists, which reads as data corruption to whoever finds it next. Re-tagging them is the
   * caller's decision to make, not this method's.
   */
  async archive(scope: ScopeContext, industryId: string): Promise<Industry> {
    const existing = await this.repository.findById(scope, industryId);
    if (!existing || existing.archivedAt !== null) throw AppError.notFound('No such industry');

    if (existing.templateCount > 0 || existing.unitCount > 0) {
      const parts = [
        existing.templateCount > 0
          ? `${existing.templateCount} checklist template${existing.templateCount === 1 ? '' : 's'}`
          : null,
        existing.unitCount > 0
          ? `${existing.unitCount} unit${existing.unitCount === 1 ? '' : 's'}`
          : null,
      ].filter(Boolean);
      throw AppError.conflict(
        'RESOURCE_IN_USE',
        `${existing.name} is still used by ${parts.join(' and ')}. Untick its checklists ` +
          'and move its units to another industry first, and then archive it.',
      );
    }

    const archived = await this.repository.update(scope, industryId, { archivedAt: new Date() });
    if (!archived) throw AppError.notFound('No such industry');

    await this.auditLog.recordSafely(
      { action: 'industry.archived', resourceType: 'industry', resourceId: industryId },
      archived.name,
    );
    const row = await this.repository.findById(scope, industryId);
    return toIndustry(row!);
  }
}

function toIndustry(row: IndustryRow): Industry {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    sortOrder: row.sortOrder,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    templateCount: row.templateCount,
    unitCount: row.unitCount,
  };
}
