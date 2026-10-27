import { Injectable } from '@nestjs/common';
import type {
  AssignZoneLeaderRequest,
  CreateZoneRequest,
  ListZonesQuery,
  Page,
  UpdateZoneRequest,
  Zone,
} from '@audit5s/contracts';
import { zoneLabelFromCode, type ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { isUniqueViolation } from '../../common/pg-errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { UnitsRepository } from '../units/units.repository';
import { ZonesRepository, type ZonePatch, type ZoneRow } from './zones.repository';
import { readZoneList, ZoneListRejected } from './zone-list-reader';

/** A Zone the file names a leader for, as R-63's account step needs it. */
export interface ImportedLeader {
  zoneId: string;
  code: string;
  leaderName: string;
  leaderPhone: string | null;
  /** The account leading the Zone after the import, if one still does. */
  zoneLeaderId: string | null;
}

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
          `Zone ${zoneLabelFromCode(request.code) ?? request.code} is already used in this Unit`,
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
    // An account chosen replaces the name an auditor typed (0015); "Nobody" sends
    // `zoneLeaderName: null` itself, copied above.
    if (patch.zoneLeaderId) patch.zoneLeaderName = null;
    // A Zone still called by its number ("Zone 1A") follows a renumbering to "Zone 4A".
    if (patch.code && patch.code !== before.code && (patch.name === undefined || patch.name === before.name)) {
      const was = zoneLabelFromCode(before.code);
      const now = zoneLabelFromCode(patch.code);
      if (was && now && before.name.trim().toLowerCase() === `zone ${was}`.toLowerCase()) {
        patch.name = `Zone ${now}`;
      }
    }

    let updatedId: string | null;
    try {
      updatedId = await this.repository.update(scope, zoneId, patch, version);
    } catch (error) {
      if (isUniqueViolation(error, 'zone_unit_code_key')) {
        throw AppError.conflict(
          'DUPLICATE_CODE',
          `Zone ${zoneLabelFromCode(String(fields.code)) ?? String(fields.code)} is already used in this Unit`,
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
      zoneLeaderName: null,
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

  /**
   * R-59: replaces the Unit's Zone list with the one in an Excel or PDF file. The clients
   * warn before a second import that it replaces the first; this does not ask again.
   *
   * The leaders it returns are for `UsersService.importZoneList`, which makes their accounts
   * (R-63): this module cannot reach the users module, which already depends on it.
   */
  async importList(scope: ScopeContext, unitId: string, body: Buffer) {
    const unit = await this.units.findById(scope, unitId);
    if (!unit) {
      throw AppError.notFound('No such Unit');
    }

    let list, notes;
    try {
      ({ zones: list, notes } = await readZoneList(body));
    } catch (error) {
      if (error instanceof ZoneListRejected) throw AppError.validation(error.message);
      throw error;
    }

    const result = await this.repository.importList(scope, unitId, list);
    if (result.busy) {
      const labels = result.busy.map((code) => `Zone ${zoneLabelFromCode(code) ?? code}`).join(', ');
      throw AppError.conflict(
        'ZONE_HAS_IN_PROGRESS_AUDIT',
        `${labels} ${result.busy.length === 1 ? 'is' : 'are'} not in the file but ${result.busy.length === 1 ? 'has' : 'have'} an audit in progress. Finish or cancel it, or keep the Zone in the file.`,
      );
    }

    await this.auditLog.record({
      action: 'zone.list_imported',
      resourceType: 'unit',
      resourceId: unitId,
      unitId,
      before: { zoneListImportedAt: unit.zoneListImportedAt?.toISOString() ?? null },
      after: {
        zones: list.length,
        created: result.created,
        updated: result.updated,
        archived: result.archived,
      },
    });
    const ids = new Map(result.imported.map((zone) => [zone.code, zone]));
    const leaders: ImportedLeader[] = list.flatMap((zone) => {
      const row = ids.get(zone.code)!;
      return zone.leaderName
        ? [{ zoneId: row.id, code: zone.code, leaderName: zone.leaderName, leaderPhone: zone.leaderPhone, zoneLeaderId: row.zoneLeaderId }]
        : [];
    });
    return {
      created: result.created,
      updated: result.updated,
      archived: result.archived,
      zoneListImportedAt: result.zoneListImportedAt.toISOString(),
      leaders,
      notes,
    };
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
    zoneLeaderName: row.zoneLeaderName,
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
