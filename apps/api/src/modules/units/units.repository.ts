import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, ilike, isNull, sql, type SQL } from 'drizzle-orm';
import { units, type Database } from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type { CreateUnitRequest, ListUnitsQuery } from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

export type UnitPatch = Partial<{
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  latitude: string | null;
  longitude: string | null;
  geofenceRadiusM: number | null;
  timezone: string;
  photoCapPerZone: number;
}>;

@Injectable()
export class UnitsRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  async create(scope: ScopeContext, request: CreateUnitRequest) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .insert(units)
        .values({
          name: request.name,
          address: request.address ?? null,
          city: request.city ?? null,
          state: request.state ?? null,
          country: request.country ?? null,
          postalCode: request.postalCode ?? null,
          contactName: request.contactName ?? null,
          contactPhone: request.contactPhone ?? null,
          contactEmail: request.contactEmail ?? null,
          latitude: request.latitude !== undefined ? String(request.latitude) : null,
          longitude: request.longitude !== undefined ? String(request.longitude) : null,
          geofenceRadiusM: request.geofenceRadiusM ?? 300,
          timezone: request.timezone,
          ...(request.photoCapPerZone !== undefined
            ? { photoCapPerZone: request.photoCapPerZone }
            : {}),
        })
        .returning();
      return row!;
    });
  }

  async findById(scope: ScopeContext, unitId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select()
        .from(units)
        // The scope predicate comes from the resolver PART 6 grants, applied here rather
        // than in the controller, so no endpoint can forget it (AZ-1).
        .where(and(eq(units.id, unitId), this.scoped(scope, { unitId: units.id })))
        .limit(1);
      return row ?? null;
    });
  }

  async list(scope: ScopeContext, query: ListUnitsQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        query.includeArchived ? undefined : isNull(units.archivedAt),
        query.search ? ilike(units.name, `%${query.search}%`) : undefined,
        query.cursor ? gt(units.id, query.cursor) : undefined,
      ];

      return tx
        .select()
        .from(units)
        .where(this.scoped(scope, { unitId: units.id }, ...filters))
        .orderBy(asc(units.id))
        .limit(query.limit + 1);
    });
  }

  /** Optimistic concurrency: `version` must match, and is bumped on success. */
  async update(scope: ScopeContext, unitId: string, patch: UnitPatch, expectedVersion?: number) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(units)
        .set({ ...patch, version: sql`${units.version} + 1` })
        .where(
          and(
            eq(units.id, unitId),
            isNull(units.archivedAt),
            this.scoped(scope, { unitId: units.id }),
            expectedVersion !== undefined ? eq(units.version, expectedVersion) : undefined,
          ),
        )
        .returning();
      return row ?? null;
    });
  }

  async archive(scope: ScopeContext, unitId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(units)
        .set({ archivedAt: sql`now()`, version: sql`${units.version} + 1` })
        .where(and(eq(units.id, unitId), this.scoped(scope, { unitId: units.id })))
        .returning();
      return row ?? null;
    });
  }
}
