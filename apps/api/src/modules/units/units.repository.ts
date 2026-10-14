import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, ilike, inArray, isNull, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { auditLogs, crossAuditCalls, crossAuditRounds, units, zones, type Database, type Transaction } from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type { CreateUnitRequest, CrossAuditCall, CrossAuditRound, ListUnitsQuery } from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';
import { auditLogRow } from '../../common/audit-log/audit-log.service';
import { getRequestContext } from '../../common/observability/request-context';

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
  industryId: string | null;
}>;

export type CrossAuditCallData = {
  unitName: string;
  roundId: string;
  /** How many Zones the call names; the Zone itself is carried only when it names one. */
  zoneCount: number;
  zoneId?: string;
  zoneCode?: string;
  zoneName?: string;
  /** "Rahul Sharma (RA3210)": who called it, for the Zone Leader's list. */
  calledBy: string | null;
  /** `YYYY-MM-DD`, the day it is due (0050). */
  dueOn: string;
};

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
          industryId: request.industryId ?? null,
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

  /**
   * A Coordinator calls one cross audit of one Zone or several (§2.6, 0051): the round, a call
   * per Zone, the log entry and the notice to the Unit's Zone Leaders commit together, or
   * nothing does. `NOT_FOUND` when the Unit is not in scope or archived, or any Zone is
   * archived or not the Unit's.
   */
  async callCrossAudit(
    scope: ScopeContext,
    unitId: string,
    zoneIds: readonly string[],
    dueOn: string | undefined,
    emit: (tx: Transaction, data: CrossAuditCallData) => Promise<void>,
  ): Promise<'CALLED' | 'NOT_FOUND' | 'PAST_DUE'> {
    const wanted = [...new Set(zoneIds)];
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [unit] = await tx
        .select({
          unitName: units.name,
          // The Unit's own day: "due today" means today in the plant, not in UTC.
          today: sql<string>`to_char((now() AT TIME ZONE ${units.timezone})::date, 'YYYY-MM-DD')`,
          weekOut: sql<string>`to_char((now() AT TIME ZONE ${units.timezone})::date + 7, 'YYYY-MM-DD')`,
        })
        .from(units)
        .where(and(eq(units.id, unitId), isNull(units.archivedAt), this.scoped(scope, { unitId: units.id })))
        .limit(1);
      if (!unit) return 'NOT_FOUND';
      const found = await tx
        .select({ zoneId: zones.id, zoneCode: zones.code, zoneName: zones.name })
        .from(zones)
        .where(and(eq(zones.unitId, unitId), inArray(zones.id, wanted), isNull(zones.archivedAt)))
        .orderBy(asc(zones.code));
      if (found.length !== wanted.length) return 'NOT_FOUND';
      const due = dueOn ?? unit.weekOut;
      if (due < unit.today) return 'PAST_DUE';
      const calledBy = getRequestContext()?.actorLabel ?? null;
      const by = { unitId, calledByUserId: scope.actor.userId, calledByLabel: calledBy ?? 'system', dueOn: due };
      const [round] = await tx.insert(crossAuditRounds).values(by).returning({ id: crossAuditRounds.id });
      await tx.insert(crossAuditCalls).values(found.map((zone) => ({ ...by, zoneId: zone.zoneId, roundId: round!.id })));
      await tx.insert(auditLogs).values(
        found.map((zone) =>
          auditLogRow({
            action: 'unit.cross_audit_called',
            resourceType: 'unit',
            resourceId: unitId,
            unitId,
            after: { ...zone, dueOn: due, roundId: round!.id },
          }),
        ),
      );
      // One notice per call, however many Zones: a single Zone is named, several are counted.
      const one = found.length === 1 ? found[0]! : null;
      await emit(tx, {
        unitName: unit.unitName,
        roundId: round!.id,
        zoneCount: found.length,
        ...(one ?? {}),
        calledBy,
        dueOn: due,
      });
      return 'CALLED';
    });
  }

  /**
   * The Unit's calls still standing, oldest due first: their cross audit is not completed,
   * and no audit of the call's Zone, by anyone, has started since it was made (owner,
   * 2026-10-14). A cross audit answers it, and so does any audit by a Coordinator of the
   * Unit. A cancelled audit or a withdrawn Zone does not. The date is the round's, which the
   * Coordinator may have moved. A Zone in several open calls is listed once. `null` when the
   * Unit is not in scope.
   */
  async listCrossAuditCalls(scope: ScopeContext, unitId: string): Promise<CrossAuditCall[] | null> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      if (!(await this.unitInScope(tx, scope, unitId))) return null;
      const rows = await tx
        .select({
          id: crossAuditCalls.id,
          unitId: crossAuditCalls.unitId,
          unitName: units.name,
          zoneId: crossAuditCalls.zoneId,
          zoneCode: zones.code,
          zoneName: zones.name,
          calledBy: crossAuditCalls.calledByLabel,
          dueOn: crossAuditRounds.dueOn,
          createdAt: crossAuditCalls.createdAt,
        })
        .from(crossAuditCalls)
        .innerJoin(crossAuditRounds, eq(crossAuditRounds.id, crossAuditCalls.roundId))
        .innerJoin(units, eq(units.id, crossAuditCalls.unitId))
        .innerJoin(zones, eq(zones.id, crossAuditCalls.zoneId))
        .where(
          and(
            eq(crossAuditCalls.unitId, unitId),
            isNull(zones.archivedAt),
            isNull(crossAuditRounds.completedAt),
            sql`NOT EXISTS (SELECT 1 ${answeringAudits(crossAuditCalls.unitId, crossAuditCalls.zoneId, crossAuditCalls.createdAt)})`,
          ),
        )
        .orderBy(asc(crossAuditRounds.dueOn), asc(crossAuditCalls.createdAt));
      // One row per Zone, the soonest due: one audit of it answers every call that names it,
      // so a Zone called twice (an older call, then "Select all") is still one thing to do.
      const seen = new Set<string>();
      return rows
        .filter((row) => !seen.has(row.zoneId) && seen.add(row.zoneId))
        .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    });
  }

  /**
   * The Unit's called cross audits, newest first (0051), each with where every Zone stands:
   * the audit that answers it — a finished one before one still running — or none yet.
   * `null` when the Unit is not in scope.
   */
  async listCrossAuditRounds(scope: ScopeContext, unitId: string): Promise<CrossAuditRound[] | null> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      if (!(await this.unitInScope(tx, scope, unitId))) return null;
      // ponytail: the latest 100 rounds; page them if a Unit ever calls more than that.
      const result = await tx.execute(sql`
        SELECT r.id, r.unit_id, r.called_by_label, to_char(r.due_on, 'YYYY-MM-DD') AS due_on, r.created_at,
               r.completed_at, r.completed_by_label, r.completion_remark,
               c.zone_id, z.code AS zone_code, z.name AS zone_name,
               answer.id AS audit_id, answer.status AS audit_status, answer.auditor_name
        FROM (SELECT * FROM cross_audit_round WHERE unit_id = ${unitId} ORDER BY created_at DESC LIMIT 100) r
        JOIN cross_audit_call c ON c.round_id = r.id
        JOIN zone z ON z.id = c.zone_id AND z.archived_at IS NULL
        LEFT JOIN LATERAL (
          SELECT a.id, a.status, u.full_name AS auditor_name
          ${answeringAudits(sql`c.unit_id`, sql`c.zone_id`, sql`c.created_at`)}
          ORDER BY a.status IN (${sql.join(FINISHED.map((status) => sql`${status}`), sql`, `)}) DESC, a.started_at
          LIMIT 1
        ) answer ON true
        ORDER BY r.created_at DESC, z.code
      `);
      const rounds = new Map<string, CrossAuditRound>();
      for (const row of result.rows as RoundRow[]) {
        let round = rounds.get(row.id);
        if (!round) {
          round = {
            id: row.id,
            unitId: row.unit_id,
            calledBy: row.called_by_label,
            dueOn: row.due_on,
            createdAt: new Date(row.created_at).toISOString(),
            completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
            completedBy: row.completed_by_label,
            completionRemark: row.completion_remark,
            zones: [],
          };
          rounds.set(row.id, round);
        }
        round.zones.push({
          zoneId: row.zone_id,
          zoneCode: row.zone_code,
          zoneName: row.zone_name,
          state: !row.audit_id ? 'NOT_STARTED' : FINISHED.includes(row.audit_status!) ? 'COMPLETED' : 'IN_PROGRESS',
          auditId: row.audit_id,
          auditorName: row.auditor_name,
        });
      }
      return [...rounds.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  /**
   * Moves a called cross audit's deadline (0051), logged with the date it replaced. Any day
   * from the Unit's today on. A completed round keeps its date.
   */
  async changeCrossAuditDeadline(
    scope: ScopeContext,
    unitId: string,
    roundId: string,
    dueOn: string,
  ): Promise<'CHANGED' | 'NOT_FOUND' | 'PAST_DUE' | 'COMPLETED'> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const round = await this.findRound(tx, scope, unitId, roundId);
      if (!round) return 'NOT_FOUND';
      if (round.completedAt) return 'COMPLETED';
      if (dueOn < round.today) return 'PAST_DUE';
      await tx.update(crossAuditRounds).set({ dueOn }).where(eq(crossAuditRounds.id, roundId));
      await tx.insert(auditLogs).values(
        auditLogRow({
          action: 'cross_audit.deadline_changed',
          resourceType: 'cross_audit_round',
          resourceId: roundId,
          unitId,
          before: { dueOn: round.dueOn },
          after: { dueOn },
        }),
      );
      return 'CHANGED';
    });
  }

  /**
   * Completes a called cross audit (0051). `REMARK_REQUIRED` when a Zone is not done and no
   * remark says why. Its calls stop standing for every Zone Leader.
   */
  async completeCrossAudit(
    scope: ScopeContext,
    unitId: string,
    roundId: string,
    remark: string | undefined,
  ): Promise<'COMPLETED' | 'NOT_FOUND' | 'ALREADY' | 'REMARK_REQUIRED'> {
    const rounds = await this.listCrossAuditRounds(scope, unitId);
    const listed = rounds?.find((round) => round.id === roundId);
    if (!listed) return 'NOT_FOUND';
    if (listed.completedAt) return 'ALREADY';
    if (listed.zones.some((zone) => zone.state !== 'COMPLETED') && !remark) return 'REMARK_REQUIRED';
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const label = getRequestContext()?.actorLabel ?? 'system';
      const [updated] = await tx
        .update(crossAuditRounds)
        .set({
          completedAt: sql`now()`,
          completedByUserId: scope.actor.userId,
          completedByLabel: label,
          completionRemark: remark || null,
        })
        .where(and(eq(crossAuditRounds.id, roundId), isNull(crossAuditRounds.completedAt)))
        .returning({ id: crossAuditRounds.id });
      if (!updated) return 'ALREADY';
      await tx.insert(auditLogs).values(
        auditLogRow({
          action: 'cross_audit.completed',
          resourceType: 'cross_audit_round',
          resourceId: roundId,
          unitId,
          after: {
            remark: remark || null,
            zonesNotDone: listed.zones.filter((zone) => zone.state !== 'COMPLETED').map((zone) => zone.zoneCode),
          },
        }),
      );
      return 'COMPLETED';
    });
  }

  private async unitInScope(tx: Transaction, scope: ScopeContext, unitId: string): Promise<boolean> {
    const [unit] = await tx
      .select({ id: units.id })
      .from(units)
      .where(and(eq(units.id, unitId), this.scoped(scope, { unitId: units.id })))
      .limit(1);
    return unit !== undefined;
  }

  private async findRound(tx: Transaction, scope: ScopeContext, unitId: string, roundId: string) {
    const [round] = await tx
      .select({
        dueOn: crossAuditRounds.dueOn,
        completedAt: crossAuditRounds.completedAt,
        today: sql<string>`to_char((now() AT TIME ZONE ${units.timezone})::date, 'YYYY-MM-DD')`,
      })
      .from(crossAuditRounds)
      .innerJoin(units, eq(units.id, crossAuditRounds.unitId))
      .where(
        and(
          eq(crossAuditRounds.id, roundId),
          eq(crossAuditRounds.unitId, unitId),
          isNull(units.archivedAt),
          this.scoped(scope, { unitId: units.id }),
        ),
      )
      .limit(1);
    return round;
  }
}

/** An audit is finished — whatever happens to its findings after — in these states. */
const FINISHED: readonly string[] = ['COMPLETED', 'CORRECTIVE_ACTION_OPEN', 'PARTIALLY_CLOSED', 'CLOSED'];

/**
 * `FROM … WHERE …` for the audits that answer a call of `zoneId` at `unitId` made at `since`
 * (R-55): started after it, not cancelled, the Zone not withdrawn, and either a cross audit
 * or any audit by a Coordinator of the Unit. `u` is the auditor.
 */
function answeringAudits(unitId: SQL | AnyColumn, zoneId: SQL | AnyColumn, since: SQL | AnyColumn): SQL {
  return sql`FROM audit a
    JOIN audit_zone az ON az.audit_id = a.id
    JOIN "user" u ON u.id = a.auditor_user_id
    WHERE a.unit_id = ${unitId}
      AND az.zone_id = ${zoneId}
      AND az.status <> 'WITHDRAWN'
      AND a.status <> 'CANCELLED'
      AND a.started_at > ${since}
      AND (a.audit_type = 'CROSS_5S' OR EXISTS (
        SELECT 1 FROM unit_membership m
        WHERE m.user_id = a.auditor_user_id AND m.unit_id = a.unit_id AND m.role = 'COORDINATOR'))`;
}

type RoundRow = {
  id: string;
  unit_id: string;
  called_by_label: string;
  due_on: string;
  created_at: string | Date;
  completed_at: string | Date | null;
  completed_by_label: string | null;
  completion_remark: string | null;
  zone_id: string;
  zone_code: string;
  zone_name: string;
  audit_id: string | null;
  audit_status: string | null;
  auditor_name: string | null;
};
