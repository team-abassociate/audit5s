import { Injectable } from '@nestjs/common';
import type {
  AssignZoneLeaderRequest,
  CreateZoneRequest,
  ListZonesQuery,
  Page,
  UpdateZoneRequest,
  Zone,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { isUniqueViolation } from '../../common/pg-errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { UnitsRepository } from '../units/units.repository';
import { ZonesRepository, type ZonePatch, type ZoneRow } from './zones.repository';

@Injectable()
export class ZonesService {
  constructor(
    private readonly repository: ZonesRepository,
    private readonly units: UnitsRepository,
    private readonly auditLog: AuditLogService,
  ) {}

  async create(scope: ScopeContext, unitId: string, request: CreateZoneRequest): Promise<Zone> {
    // The Unit is read through the actor's own scope first, so a Coordinator posting
    // another Unit's id gets 404 rather than a foreign-key error that confirms it exists.
    const unit = await this.units.findById(scope, unitId);
    if (!unit) {
      throw AppError.notFound('No such Unit');
    }

    if (request.zoneLeaderId) {
      await this.assertLeaderBelongsToUnit(scope, unitId, request.zoneLeaderId);
    }

    let zoneId: string;
    try {
      zoneId = await this.repository.create(scope, unitId, request);
    } catch (error) {
      if (isUniqueViolation(error, 'zone_unit_code_key')) {
        throw AppError.conflict(
          'DUPLICATE_CODE',
          `Zone code '${request.code}' is already used in this Unit`,
        );
      }
      throw error;
    }

    const created = await this.mustFind(scope, zoneId);
    await this.auditLog.record({
      action: 'zone.created',
      resourceType: 'zone',
      resourceId: created.id,
      unitId,
      after: { code: created.code, name: created.name, zoneLeaderId: created.zoneLeaderId },
    });
    return toZone(created);
  }

  async list(scope: ScopeContext, query: ListZonesQuery, unitId?: string): Promise<Page<Zone>> {
    if (unitId) {
      const unit = await this.units.findById(scope, unitId);
      if (!unit) {
        throw AppError.notFound('No such Unit');
      }
    }
    const rows = await this.repository.list(scope, query, unitId);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toZone), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  async get(scope: ScopeContext, zoneId: string): Promise<Zone> {
    return toZone(await this.mustFind(scope, zoneId));
  }

  async update(scope: ScopeContext, zoneId: string, request: UpdateZoneRequest): Promise<Zone> {
    const { version, ...fields } = request;
    const before = await this.mustFind(scope, zoneId);

    if (fields.zoneLeaderId) {
      await this.assertLeaderBelongsToUnit(scope, before.unitId, fields.zoneLeaderId);
    }

    const patch: ZonePatch = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      (patch as Record<string, unknown>)[key] = value;
    }

    let updatedId: string | null;
    try {
      updatedId = await this.repository.update(scope, zoneId, patch, version);
    } catch (error) {
      if (isUniqueViolation(error, 'zone_unit_code_key')) {
        throw AppError.conflict(
          'DUPLICATE_CODE',
          `Zone code '${String(fields.code)}' is already used in this Unit`,
        );
      }
      throw error;
    }

    if (!updatedId) {
      if (version !== undefined && before.version !== version) {
        throw AppError.conflict('VERSION_CONFLICT', 'This Zone was changed by someone else');
      }
      // Archived, or it left scope between the read and the write.
      throw AppError.notFound('No such Zone');
    }

    const after = await this.mustFind(scope, zoneId);
    await this.auditLog.record({
      action: 'zone.updated',
      resourceType: 'zone',
      resourceId: zoneId,
      unitId: before.unitId,
      before: audited(before),
      after: audited(after),
    });
    return toZone(after);
  }

  /**
   * The leader pointer, as its own endpoint.
   *
   * PART 6 grants `zone:assign_leader` separately from `zone:update`, so it is a separate
   * route: the two are not the same decision, and a matrix that says so should not be
   * collapsed into one handler.
   */
  async assignLeader(
    scope: ScopeContext,
    zoneId: string,
    request: AssignZoneLeaderRequest,
  ): Promise<Zone> {
    const before = await this.mustFind(scope, zoneId);

    if (request.zoneLeaderId) {
      await this.assertLeaderBelongsToUnit(scope, before.unitId, request.zoneLeaderId);
    }

    const updatedId = await this.repository.update(scope, zoneId, {
      zoneLeaderId: request.zoneLeaderId,
    });
    if (!updatedId) {
      throw AppError.notFound('No such Zone');
    }

    const after = await this.mustFind(scope, zoneId);
    await this.auditLog.record({
      action: 'zone.leader_assigned',
      resourceType: 'zone',
      resourceId: zoneId,
      unitId: before.unitId,
      before: { zoneLeaderId: before.zoneLeaderId },
      after: { zoneLeaderId: after.zoneLeaderId },
    });
    return toZone(after);
  }

  async archive(scope: ScopeContext, zoneId: string): Promise<void> {
    const zone = await this.mustFind(scope, zoneId);

    // §8.4: archiving a Zone that is mid-audit would strand the auditor's device, which
    // holds the questionnaire offline and cannot be told to stop.
    if (await this.repository.hasInProgressAudit(scope, zoneId)) {
      throw AppError.conflict(
        'ZONE_HAS_IN_PROGRESS_AUDIT',
        'This Zone has an audit in progress. Complete or cancel it before archiving the Zone.',
      );
    }

    const archived = await this.repository.archive(scope, zoneId);
    if (!archived) {
      throw AppError.notFound('No such Zone');
    }

    await this.auditLog.record({
      action: 'zone.archived',
      resourceType: 'zone',
      resourceId: zoneId,
      unitId: zone.unitId,
      after: { archivedAt: new Date().toISOString() },
    });
  }

  private async mustFind(scope: ScopeContext, zoneId: string): Promise<ZoneRow> {
    const zone = await this.repository.findById(scope, zoneId);
    // AZ-3: out of scope reads as absent, so Zone ids cannot be probed across Units.
    if (!zone) {
      throw AppError.notFound('No such Zone');
    }
    return zone;
  }

  private async assertLeaderBelongsToUnit(
    scope: ScopeContext,
    unitId: string,
    userId: string,
  ): Promise<void> {
    if (!(await this.repository.isZoneLeaderOfUnit(scope, unitId, userId))) {
      throw AppError.validation('The named Zone Leader is not an active member of this Unit', [
        { field: 'zoneLeaderId', message: 'Not an active Zone Leader of this Unit' },
      ]);
    }
  }
}

function audited(row: ZoneRow) {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    departmentHint: row.departmentHint,
    defaultChecklistTemplateId: row.defaultChecklistTemplateId,
    zoneLeaderId: row.zoneLeaderId,
    sortOrder: row.sortOrder,
  };
}

export function toZone(row: ZoneRow): Zone {
  return {
    id: row.id,
    unitId: row.unitId,
    code: row.code,
    name: row.name,
    description: row.description,
    departmentHint: row.departmentHint,
    defaultChecklistTemplateId: row.defaultChecklistTemplateId,
    zoneLeaderId: row.zoneLeaderId,
    zoneLeaderName: row.zoneLeaderName,
    sortOrder: row.sortOrder,
    version: row.version,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
