import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, ilike, isNull, sql, type SQL } from 'drizzle-orm';
import { unitMemberships, users, zones, type Database } from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type { CreateZoneRequest, ListZonesQuery } from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

export type ZonePatch = Partial<{
  code: string;
  name: string;
  description: string | null;
  departmentHint: string | null;
  defaultChecklistTemplateId: string | null;
  zoneLeaderId: string | null;
  sortOrder: number;
}>;

/**
 * `zone` joined to the Zone Leader's name.
 *
 * The name is denormalised into every read because both clients show it and the device
 * caches it for offline browsing (PART 9.1's local `zone` table). It is a display value,
 * never an authorization input — the leader pointer grants nothing (C2).
 */
const zoneColumns = {
  id: zones.id,
  unitId: zones.unitId,
  code: zones.code,
  name: zones.name,
  description: zones.description,
  departmentHint: zones.departmentHint,
  defaultChecklistTemplateId: zones.defaultChecklistTemplateId,
  zoneLeaderId: zones.zoneLeaderId,
  zoneLeaderName: users.fullName,
  sortOrder: zones.sortOrder,
  version: zones.version,
  archivedAt: zones.archivedAt,
  createdAt: zones.createdAt,
  updatedAt: zones.updatedAt,
};

@Injectable()
export class ZonesRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  /**
   * `unitId` comes from the path and is intersected with the actor's scope, never trusted
   * as a grant (AZ-2): the predicate below still applies, so a Coordinator posting another
   * Unit's id writes nothing.
   */
  async create(scope: ScopeContext, unitId: string, request: CreateZoneRequest) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .insert(zones)
        .values({
          unitId,
          code: request.code,
          name: request.name,
          description: request.description ?? null,
          departmentHint: request.departmentHint ?? null,
          defaultChecklistTemplateId: request.defaultChecklistTemplateId ?? null,
          zoneLeaderId: request.zoneLeaderId ?? null,
          ...(request.sortOrder !== undefined ? { sortOrder: request.sortOrder } : {}),
        })
        .returning({ id: zones.id });
      return row!.id;
    });
  }

  async findById(scope: ScopeContext, zoneId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select(zoneColumns)
        .from(zones)
        .leftJoin(users, eq(users.id, zones.zoneLeaderId))
        .where(and(eq(zones.id, zoneId), this.scoped(scope, { unitId: zones.unitId })))
        .limit(1);
      return row ?? null;
    });
  }

  async list(scope: ScopeContext, query: ListZonesQuery, unitId?: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        unitId ? eq(zones.unitId, unitId) : undefined,
        query.active ? isNull(zones.archivedAt) : undefined,
        query.search ? ilike(zones.name, `%${query.search}%`) : undefined,
        query.cursor ? gt(zones.id, query.cursor) : undefined,
      ];

      return tx
        .select(zoneColumns)
        .from(zones)
        .leftJoin(users, eq(users.id, zones.zoneLeaderId))
        .where(this.scoped(scope, { unitId: zones.unitId }, ...filters))
        // Cursor paging is on the id, so the sort order the dropdown wants is applied by
        // the caller. Zones per Unit are tens, not thousands.
        .orderBy(asc(zones.id))
        .limit(query.limit + 1);
    });
  }

  /** Every Zone of every Unit in scope, for the catalogue. Active only, in display order. */
  async listActiveForCatalogue(scope: ScopeContext) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select(zoneColumns)
        .from(zones)
        .leftJoin(users, eq(users.id, zones.zoneLeaderId))
        .where(this.scoped(scope, { unitId: zones.unitId }, isNull(zones.archivedAt)))
        .orderBy(asc(zones.unitId), asc(zones.sortOrder), asc(zones.code));
    });
  }

  async update(scope: ScopeContext, zoneId: string, patch: ZonePatch, expectedVersion?: number) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(zones)
        .set({ ...patch, version: sql`${zones.version} + 1` })
        .where(
          and(
            eq(zones.id, zoneId),
            isNull(zones.archivedAt),
            this.scoped(scope, { unitId: zones.unitId }),
            expectedVersion !== undefined ? eq(zones.version, expectedVersion) : undefined,
          ),
        )
        .returning({ id: zones.id });
      return row?.id ?? null;
    });
  }

  async archive(scope: ScopeContext, zoneId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(zones)
        .set({ archivedAt: sql`now()`, version: sql`${zones.version} + 1` })
        .where(and(eq(zones.id, zoneId), this.scoped(scope, { unitId: zones.unitId })))
        .returning({ id: zones.id });
      return row?.id ?? null;
    });
  }

  /**
   * The archive guard of §8.4.
   *
   * `audit_zone` lands in Phase 3, so the answer comes from the database function the
   * migration defines rather than from a query this repository would have to rewrite —
   * Phase 3 replaces one function body and this call starts returning true.
   */
  async hasInProgressAudit(scope: ScopeContext, zoneId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const result = await tx.execute<{ busy: boolean }>(
        sql`SELECT zone_has_in_progress_audit(${zoneId}::uuid) AS busy`,
      );
      return Boolean(result.rows[0]?.busy);
    });
  }

  /**
   * Whether a user is an ACTIVE ZONE_LEADER of this Unit.
   *
   * Pointing a Zone at someone who has no membership there would create a dangling
   * responsibility: the person named on the report could not open it.
   */
  async isZoneLeaderOfUnit(scope: ScopeContext, unitId: string, userId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({ id: unitMemberships.id })
        .from(unitMemberships)
        .where(
          and(
            eq(unitMemberships.userId, userId),
            eq(unitMemberships.unitId, unitId),
            eq(unitMemberships.role, 'ZONE_LEADER'),
            eq(unitMemberships.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      return row !== undefined;
    });
  }
}

export type ZoneRow = NonNullable<Awaited<ReturnType<ZonesRepository['findById']>>>;
