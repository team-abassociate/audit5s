import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, ilike, isNull, sql, type SQL } from 'drizzle-orm';
import { unitMemberships, units, zones, type Database } from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type { CreateZoneRequest, ListZonesQuery } from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';
import type { ImportedZone } from './zone-list-reader';

export type ZonePatch = Partial<{
  code: string;
  name: string;
  description: string | null;
  departmentHint: string | null;
  defaultChecklistTemplateId: string | null;
  zoneLeaderId: string | null;
  /** Only ever cleared here: a leader chosen on the form replaces the one an auditor typed. */
  zoneLeaderName: null;
  sortOrder: number;
}>;

/** "Mr. A.  Sharma" and "mr. a. sharma" are one person: the key a leader is matched on. */
export function leaderNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameName(a: string | null, b: string): boolean {
  return a !== null && leaderNameKey(a) === leaderNameKey(b);
}

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
  /**
   * Through `app_zone_leader_name`, not a join on `"user"`.
   *
   * PART 6 gives a Consultant and a Zone Leader `own_record` on `user:read`, so
   * `user_select` admits their own row and no other — and a left join therefore produced
   * a silent NULL for every reader but a Super Admin or the Unit's Coordinator. That is
   * how `GET /sync/catalogue` came to cache Zones whose leader had no name. The definer
   * function of 0008 returns the display name alone, scoped to the caller's own Units
   * (DECISIONS.md R-12f).
   *
   * Coalesced with `zone.zone_leader_name` (0015): a Zone whose leader has no user account
   * still has a leader, and the name an auditor typed is who it is. The account is first
   * because an assigned account outranks anything typed — the same precedence
   * `app_set_zone_leader_name()` enforces on the way in, so a Zone cannot read one way and
   * write the other.
   */
  zoneLeaderName: sql<
    string | null
  >`COALESCE(app_zone_leader_name(${zones.unitId}, ${zones.zoneLeaderId}), ${zones.zoneLeaderName})`,
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
   * R-59: the file's Zones become the Unit's list, in one transaction. A Zone it names is
   * added, or updated (and restored, if archived) by its code; a Zone it leaves out is
   * archived — never deleted, its audits stay on record. The imported name is the Zone's
   * typed leader; an account leader is kept only while the file names that same person (or
   * no one). A file naming someone else replaces the account — the list is the Unit's
   * own record, not an auditor's guess (0015's precedence guards the latter).
   *
   * Returns the codes of Zones it would archive that have an audit in progress, and
   * changes nothing, when there are any (§8.4's archive guard).
   */
  async importList(scope: ScopeContext, unitId: string, list: readonly ImportedZone[]) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const existing = await tx
        .select({
          id: zones.id,
          code: zones.code,
          name: zones.name,
          zoneLeaderId: zones.zoneLeaderId,
          accountLeaderName: sql<
            string | null
          >`app_zone_leader_name(${zones.unitId}, ${zones.zoneLeaderId})`,
          zoneLeaderName: zones.zoneLeaderName,
          sortOrder: zones.sortOrder,
          archivedAt: zones.archivedAt,
        })
        .from(zones)
        .where(this.scoped(scope, { unitId: zones.unitId }, eq(zones.unitId, unitId)));

      const kept = new Set(list.map((zone) => zone.code));
      const leaving = existing.filter((zone) => zone.archivedAt === null && !kept.has(zone.code));
      const busy: string[] = [];
      for (const zone of leaving) {
        const result = await tx.execute<{ busy: boolean }>(
          sql`SELECT zone_has_in_progress_audit(${zone.id}::uuid) AS busy`,
        );
        if (result.rows[0]?.busy) busy.push(zone.code);
      }
      if (busy.length > 0) return { busy };

      const byCode = new Map(existing.map((zone) => [zone.code, zone]));
      let created = 0;
      let updated = 0;
      /** The file's Zones as they now stand, for R-63's leader accounts. */
      const imported: Array<{ id: string; code: string; zoneLeaderId: string | null }> = [];
      for (const zone of list) {
        const found = byCode.get(zone.code);
        if (!found) {
          const [row] = await tx
            .insert(zones)
            .values({
              unitId,
              code: zone.code,
              name: zone.name,
              zoneLeaderName: zone.leaderName,
              sortOrder: zone.sortOrder,
            })
            .returning({ id: zones.id });
          imported.push({ id: row!.id, code: zone.code, zoneLeaderId: null });
          created += 1;
          continue;
        }
        const replacesAccount =
          found.zoneLeaderId !== null &&
          zone.leaderName !== null &&
          !sameName(found.accountLeaderName, zone.leaderName);
        imported.push({ id: found.id, code: zone.code, zoneLeaderId: replacesAccount ? null : found.zoneLeaderId });
        if (
          replacesAccount ||
          found.name !== zone.name ||
          found.zoneLeaderName !== zone.leaderName ||
          found.sortOrder !== zone.sortOrder ||
          found.archivedAt !== null
        ) {
          await tx
            .update(zones)
            .set({
              name: zone.name,
              zoneLeaderName: zone.leaderName,
              ...(replacesAccount ? { zoneLeaderId: null } : {}),
              sortOrder: zone.sortOrder,
              archivedAt: null,
              version: sql`${zones.version} + 1`,
            })
            .where(this.scoped(scope, { unitId: zones.unitId }, eq(zones.id, found.id)));
          updated += 1;
        }
      }
      for (const zone of leaving) {
        await tx
          .update(zones)
          .set({ archivedAt: sql`now()`, version: sql`${zones.version} + 1` })
          .where(this.scoped(scope, { unitId: zones.unitId }, eq(zones.id, zone.id)));
      }

      const [unit] = await tx
        .update(units)
        .set({ zoneListImportedAt: sql`now()` })
        .where(this.scoped(scope, { unitId: units.id }, eq(units.id, unitId)))
        .returning({ zoneListImportedAt: units.zoneListImportedAt });
      return {
        busy: null,
        imported,
        created,
        updated,
        archived: leaving.length,
        zoneListImportedAt: unit!.zoneListImportedAt!,
      };
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
