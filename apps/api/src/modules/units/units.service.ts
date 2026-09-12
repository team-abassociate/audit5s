import { Injectable } from '@nestjs/common';
import {
  UNIT_COORDINATOR_EDITABLE_FIELDS,
  type CreateUnitRequest,
  type ListUnitsQuery,
  type Page,
  type Unit,
  type UpdateUnitRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { isUniqueViolation } from '../../common/pg-errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { UnitsRepository, type UnitPatch } from './units.repository';

@Injectable()
export class UnitsService {
  constructor(
    private readonly repository: UnitsRepository,
    private readonly auditLog: AuditLogService,
  ) {}

  async create(scope: ScopeContext, request: CreateUnitRequest): Promise<Unit> {
    try {
      const created = await this.repository.create(scope, request);
      await this.auditLog.record({
        action: 'unit.created',
        resourceType: 'unit',
        resourceId: created.id,
        unitId: created.id,
        after: { name: created.name },
      });
      return toUnit(created);
    } catch (error) {
      if (isUniqueViolation(error, 'unit_name_key')) {
        throw AppError.conflict('DUPLICATE_NAME', `A Unit named '${request.name}' already exists`);
      }
      throw error;
    }
  }

  async list(scope: ScopeContext, query: ListUnitsQuery): Promise<Page<Unit>> {
    const rows = await this.repository.list(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toUnit), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  async get(scope: ScopeContext, unitId: string): Promise<Unit> {
    const unit = await this.repository.findById(scope, unitId);
    // AZ-3 and the §6.4 worked example: a Coordinator reading another Unit gets 404, not
    // 403 — the Unit exists, and the response must not reveal that.
    if (!unit) {
      throw AppError.notFound('No such Unit');
    }
    return toUnit(unit);
  }

  /**
   * Invariant U-1, enforced at the field level.
   *
   * A Coordinator sending `name` gets `403 FIELD_NOT_EDITABLE` **listing the offending
   * field**, rather than a silent drop. The check happens here, in the update resolver,
   * not merely in the UI — the §6.4 worked example is exactly this case.
   */
  async update(scope: ScopeContext, unitId: string, request: UpdateUnitRequest): Promise<Unit> {
    const { version, ...fields } = request;
    const supplied = Object.keys(fields);

    if (scope.actor.role === 'COORDINATOR') {
      const rejected = supplied.filter(
        (field) => !(UNIT_COORDINATOR_EDITABLE_FIELDS as readonly string[]).includes(field),
      );
      if (rejected.length > 0) {
        throw AppError.fieldNotEditable(rejected);
      }
    }

    const before = await this.repository.findById(scope, unitId);
    if (!before) {
      throw AppError.notFound('No such Unit');
    }

    const patch: UnitPatch = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (key === 'latitude' || key === 'longitude') {
        patch[key] = value === null ? null : String(value);
      } else {
        (patch as Record<string, unknown>)[key] = value;
      }
    }

    const updated = await this.repository.update(scope, unitId, patch, version);
    if (!updated) {
      // Either it left scope or the version moved under us. The version case is the
      // interesting one, and the client needs to be able to tell them apart.
      if (version !== undefined && before.version !== version) {
        throw AppError.conflict('VERSION_CONFLICT', 'This Unit was changed by someone else');
      }
      throw AppError.notFound('No such Unit');
    }

    await this.auditLog.record({
      action: 'unit.updated',
      resourceType: 'unit',
      resourceId: unitId,
      unitId,
      before: pickAudited(before),
      after: pickAudited(updated),
    });

    return toUnit(updated);
  }

  async archive(scope: ScopeContext, unitId: string): Promise<void> {
    const archived = await this.repository.archive(scope, unitId);
    if (!archived) {
      throw AppError.notFound('No such Unit');
    }
    await this.auditLog.record({
      action: 'unit.archived',
      resourceType: 'unit',
      resourceId: unitId,
      unitId,
      after: { archivedAt: archived.archivedAt?.toISOString() ?? null },
    });
  }
}

type UnitRow = NonNullable<Awaited<ReturnType<UnitsRepository['findById']>>>;

function pickAudited(row: UnitRow) {
  return {
    name: row.name,
    address: row.address,
    city: row.city,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    latitude: row.latitude,
    longitude: row.longitude,
    geofenceRadiusM: row.geofenceRadiusM,
    timezone: row.timezone,
  };
}

export function toUnit(row: UnitRow): Unit {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    city: row.city,
    state: row.state,
    country: row.country,
    postalCode: row.postalCode,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    geofenceRadiusM: row.geofenceRadiusM,
    timezone: row.timezone,
    photoCapPerZone: row.photoCapPerZone,
    version: row.version,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

