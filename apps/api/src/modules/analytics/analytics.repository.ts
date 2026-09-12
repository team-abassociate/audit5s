import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import {
  audits,
  auditZones,
  auditZoneSectionScores,
  correctiveActions,
  deviceSyncRecords,
  metricDailyUnits,
  metricDailyZones,
  metricSectionDaily,
  units,
  users,
  zones,
  type Database,
  type Transaction,
} from '@audit5s/db';
import type { SSection } from '@audit5s/contracts';
import {
  COMPLETED_AUDIT_STATUSES,
  S_SECTION_ORDER,
  sumTotals,
  type ScopeContext,
  type ScoreTotals,
} from '@audit5s/domain';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

export interface AnalyticsRange {
  from: Date;
  to: Date;
  fromDay: string;
  toDay: string;
}

const completed = () => inArray(audits.status, [...COMPLETED_AUDIT_STATUSES]);
const scorePart = (rawScore: number, maxScore: number): ScoreTotals => ({
  applicableQuestions: 0,
  naQuestions: 0,
  rawScore,
  maxScore,
  scorePercentage: null,
});

@Injectable()
export class AnalyticsRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  private inScope<T>(scope: ScopeContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return work(tx);
    });
  }

  async dailyUnits(scope: ScopeContext, range: AnalyticsRange, unitId?: string) {
    return this.inScope(scope, (tx) =>
      tx
        .select()
        .from(metricDailyUnits)
        .where(
          this.scoped(
            scope,
            { unitId: metricDailyUnits.unitId },
            gte(metricDailyUnits.day, range.fromDay),
            lt(metricDailyUnits.day, range.toDay),
            unitId ? eq(metricDailyUnits.unitId, unitId) : undefined,
          ),
        )
        .orderBy(asc(metricDailyUnits.day)),
    );
  }

  async dailyZones(scope: ScopeContext, range: AnalyticsRange, unitId: string) {
    return this.inScope(scope, (tx) =>
      tx
        .select({
          row: metricDailyZones,
          zoneCode: zones.code,
          zoneName: zones.name,
        })
        .from(metricDailyZones)
        .innerJoin(zones, eq(zones.id, metricDailyZones.zoneId))
        .where(
          this.scoped(
            scope,
            { unitId: metricDailyZones.unitId },
            eq(metricDailyZones.unitId, unitId),
            gte(metricDailyZones.day, range.fromDay),
            lt(metricDailyZones.day, range.toDay),
          ),
        )
        .orderBy(asc(metricDailyZones.day)),
    );
  }

  async dailySections(scope: ScopeContext, range: AnalyticsRange, unitId: string) {
    return this.inScope(scope, (tx) =>
      tx
        .select()
        .from(metricSectionDaily)
        .where(
          this.scoped(
            scope,
            { unitId: metricSectionDaily.unitId },
            eq(metricSectionDaily.unitId, unitId),
            gte(metricSectionDaily.day, range.fromDay),
            lt(metricSectionDaily.day, range.toDay),
          ),
        )
        .orderBy(asc(metricSectionDaily.day), asc(metricSectionDaily.section)),
    );
  }

  async unitRows(scope: ScopeContext) {
    return this.inScope(scope, (tx) =>
      tx
        .select({ id: units.id, code: units.code, name: units.name, timezone: units.timezone })
        .from(units)
        .where(this.scoped(scope, { unitId: units.id }, isNull(units.archivedAt)))
        .orderBy(asc(units.code)),
    );
  }

  async zoneCount(scope: ScopeContext, unitId: string): Promise<number> {
    return this.inScope(scope, async (tx) => {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(zones)
        .where(this.scoped(scope, { unitId: zones.unitId }, eq(zones.unitId, unitId), isNull(zones.archivedAt)));
      return row?.count ?? 0;
    });
  }

  async activeAuditors(scope: ScopeContext, range: AnalyticsRange, unitId?: string): Promise<number> {
    return this.inScope(scope, async (tx) => {
      const [row] = await tx
        .select({ count: sql<number>`count(DISTINCT ${audits.auditorUserId})::int` })
        .from(audits)
        .where(
          this.scoped(
            scope,
            { unitId: audits.unitId },
            completed(),
            gte(audits.completedAt, range.from),
            lt(audits.completedAt, range.to),
            unitId ? eq(audits.unitId, unitId) : undefined,
          ),
        );
      return row?.count ?? 0;
    });
  }

  async zoneScoreHistory(scope: ScopeContext, range: AnalyticsRange, unitId: string) {
    return this.inScope(scope, (tx) =>
      tx
        .select({
          zoneId: zones.id,
          zoneCode: zones.code,
          zoneName: zones.name,
          completedAt: auditZones.completedAt,
          scorePercentage: auditZones.scorePercentage,
        })
        .from(auditZones)
        .innerJoin(audits, eq(audits.id, auditZones.auditId))
        .innerJoin(zones, eq(zones.id, auditZones.zoneId))
        .where(
          this.scoped(
            scope,
            { unitId: audits.unitId },
            eq(audits.unitId, unitId),
            completed(),
            isNotNull(auditZones.completedAt),
            isNotNull(auditZones.scorePercentage),
            gte(auditZones.completedAt, range.from),
            lt(auditZones.completedAt, range.to),
          ),
        )
        .orderBy(asc(zones.code), asc(auditZones.completedAt)),
    );
  }

  async latestSections(scope: ScopeContext, unitId: string) {
    return this.inScope(scope, async (tx) => {
      const result = await tx.execute(sql<{
        section: SSection;
        score_percentage: string | null;
        audit_zone_id: string;
        ordinal: number;
      }>`
        WITH completed_zones AS (
          SELECT audit_zone.id, audit_zone.completed_at,
                 dense_rank() OVER (ORDER BY audit_zone.completed_at DESC, audit_zone.id DESC) AS ordinal
          FROM audit_zone
          JOIN audit ON audit.id = audit_zone.audit_id
          WHERE ${this.scoped(scope, { unitId: audits.unitId }, eq(audits.unitId, unitId), completed())}
            AND audit_zone.completed_at IS NOT NULL
            AND audit_zone.score_percentage IS NOT NULL
        )
        SELECT audit_zone_section_score.section, audit_zone_section_score.score_percentage,
               audit_zone_section_score.audit_zone_id, completed_zones.ordinal::int
        FROM completed_zones
        JOIN audit_zone_section_score
          ON audit_zone_section_score.audit_zone_id = completed_zones.id
        WHERE completed_zones.ordinal <= 2
        ORDER BY completed_zones.ordinal, audit_zone_section_score.section
      `);
      return result.rows as Array<{
        section: SSection;
        score_percentage: string | null;
        audit_zone_id: string;
        ordinal: number;
      }>;
    });
  }

  async openNonconformitiesByZone(scope: ScopeContext, unitId: string) {
    return this.inScope(scope, (tx) =>
      tx
        .select({ zoneId: correctiveActions.zoneId, count: sql<number>`count(*)::int` })
        .from(correctiveActions)
        .where(
          this.scoped(
            scope,
            { unitId: correctiveActions.unitId },
            eq(correctiveActions.unitId, unitId),
            inArray(correctiveActions.status, ['OPEN', 'REOPENED']),
          ),
        )
        .groupBy(correctiveActions.zoneId),
    );
  }

  async weakSectionsByZone(scope: ScopeContext, range: AnalyticsRange, unitId: string) {
    return this.inScope(scope, async (tx) => {
      const result = await tx.execute(sql<{
        zone_id: string;
        section: SSection;
        raw_score: number;
        max_score: number;
      }>`
        SELECT metric_section_daily.zone_id, metric_section_daily.section,
               sum(metric_section_daily.raw_score)::int AS raw_score,
               sum(metric_section_daily.max_score)::int AS max_score
        FROM metric_section_daily
        WHERE ${this.scoped(
          scope,
          { unitId: metricSectionDaily.unitId },
          eq(metricSectionDaily.unitId, unitId),
          gte(metricSectionDaily.day, range.fromDay),
          lt(metricSectionDaily.day, range.toDay),
        )}
          AND metric_section_daily.max_score > 0
        GROUP BY metric_section_daily.zone_id, metric_section_daily.section
      `);
      return result.rows as Array<{
        zone_id: string;
        section: SSection;
        raw_score: number;
        max_score: number;
      }>;
    });
  }

  async recurrent(scope: ScopeContext, range: AnalyticsRange, unitId: string) {
    return this.inScope(scope, async (tx) => {
      const result = await tx.execute(sql<{
        checklist_question_id: string;
        question_text: string;
        section: SSection;
        zone_id: string;
        zone_code: string;
        zone_name: string;
        failure_count: number;
        last_seen_at: Date;
      }>`
        SELECT question_response.checklist_question_id,
               checklist_question.text AS question_text, checklist_question.section,
               audit_zone.zone_id, zone.code AS zone_code, zone.name AS zone_name,
               count(*)::int AS failure_count, max(audit_zone.completed_at) AS last_seen_at
        FROM question_response
        JOIN audit_zone ON audit_zone.id = question_response.audit_zone_id
        JOIN audit ON audit.id = audit_zone.audit_id
        JOIN checklist_question ON checklist_question.id = question_response.checklist_question_id
        JOIN zone ON zone.id = audit_zone.zone_id
        WHERE ${this.scoped(
          scope,
          { unitId: audits.unitId },
          eq(audits.unitId, unitId),
          completed(),
          gte(auditZones.completedAt, range.from),
          lt(auditZones.completedAt, range.to),
        )}
          AND question_response.value IN ('SCORE_0','SCORE_1')
        GROUP BY question_response.checklist_question_id, checklist_question.text,
                 checklist_question.section, audit_zone.zone_id, zone.code, zone.name
        HAVING count(*) >= 2
        ORDER BY failure_count DESC, last_seen_at DESC
      `);
      return result.rows as Array<{
        checklist_question_id: string;
        question_text: string;
        section: SSection;
        zone_id: string;
        zone_code: string;
        zone_name: string;
        failure_count: number;
        last_seen_at: Date;
      }>;
    });
  }

  async closure(scope: ScopeContext, range: AnalyticsRange, unitId?: string) {
    return this.inScope(scope, async (tx) => {
      const result = await tx.execute(sql<Record<string, unknown>>`
        SELECT corrective_action.unit_id, unit.name AS unit_name,
               corrective_action.zone_id, zone.name AS zone_name,
               corrective_action.assigned_zone_leader_user_id AS leader_id,
               COALESCE(app_zone_leader_name(
                 corrective_action.unit_id,
                 corrective_action.assigned_zone_leader_user_id
               ), 'Unassigned') AS leader_name,
               count(*)::int AS opened,
               count(*) FILTER (WHERE corrective_action.last_submitted_at IS NOT NULL)::int AS submitted,
               count(*) FILTER (WHERE corrective_action.resolved_at IS NOT NULL)::int AS resolved,
               avg(extract(epoch FROM (corrective_action.resolved_at - corrective_action.opened_at)) / 3600)
                 FILTER (WHERE corrective_action.resolved_at IS NOT NULL) AS avg_closure_hours
        FROM corrective_action
        JOIN unit ON unit.id = corrective_action.unit_id
        JOIN zone ON zone.id = corrective_action.zone_id
        WHERE ${this.scoped(
          scope,
          { unitId: correctiveActions.unitId },
          gte(correctiveActions.openedAt, range.from),
          lt(correctiveActions.openedAt, range.to),
          unitId ? eq(correctiveActions.unitId, unitId) : undefined,
        )}
        GROUP BY corrective_action.unit_id, unit.name, corrective_action.zone_id, zone.name,
                 corrective_action.assigned_zone_leader_user_id, leader_name
      `);
      return result.rows;
    });
  }

  async consultantActivity(scope: ScopeContext, range: AnalyticsRange, unitId?: string, own = false) {
    return this.inScope(scope, async (tx) => {
      const predicate = own
        ? this.scoped(scope, { recordUserId: audits.auditorUserId })
        : this.scoped(scope, { unitId: audits.unitId }, unitId ? eq(audits.unitId, unitId) : undefined);
      const result = await tx.execute(sql<Record<string, unknown>>`
        WITH scoped_audit AS (
          SELECT audit.id, audit.auditor_user_id, audit.started_at, audit.completed_at
          FROM audit
          WHERE ${predicate} AND ${completed()}
            AND audit.completed_at >= ${range.from} AND audit.completed_at < ${range.to}
        ), audit_activity AS (
          SELECT auditor_user_id, count(*)::int AS audits_completed,
                 avg(extract(epoch FROM (completed_at - started_at)) / 60)
                   AS average_duration_minutes,
                 max(completed_at) AS last_active_at
          FROM scoped_audit
          GROUP BY auditor_user_id
        ), coverage AS (
          SELECT scoped_audit.auditor_user_id,
                 count(DISTINCT audit_zone.zone_id)::int AS zones_covered,
                 count(DISTINCT evidence.id)::int AS photos_captured
          FROM scoped_audit
          LEFT JOIN audit_zone ON audit_zone.audit_id = scoped_audit.id
          LEFT JOIN evidence ON evidence.audit_id = scoped_audit.id
            AND evidence.kind <> 'AUDITOR_SELFIE' AND evidence.deleted_at IS NULL
          GROUP BY scoped_audit.auditor_user_id
        )
        SELECT "user".id AS user_id, "user".full_name,
               audit_activity.audits_completed, coverage.zones_covered,
               coverage.photos_captured, audit_activity.average_duration_minutes,
               audit_activity.last_active_at
        FROM audit_activity
        JOIN "user" ON "user".id = audit_activity.auditor_user_id
        JOIN coverage ON coverage.auditor_user_id = audit_activity.auditor_user_id
        WHERE "user".role = 'CONSULTANT'
        ORDER BY audit_activity.audits_completed DESC, "user".full_name
      `);
      return result.rows;
    });
  }

  async zoneLeaderActivity(scope: ScopeContext, range: AnalyticsRange, unitId?: string, own = false) {
    return this.inScope(scope, async (tx) => {
      const scopeSql = own
        ? this.scoped(scope, { recordUserId: users.id })
        : this.scoped(scope, { unitId: correctiveActions.unitId }, unitId ? eq(correctiveActions.unitId, unitId) : undefined);
      const result = await tx.execute(sql<Record<string, unknown>>`
        SELECT "user".id AS user_id, "user".full_name,
          (SELECT count(*)::int FROM audit
           WHERE audit.auditor_user_id = "user".id AND audit.audit_type = 'CROSS_5S'
             AND audit.status IN ('COMPLETED','CORRECTIVE_ACTION_OPEN','PARTIALLY_CLOSED','CLOSED')
             AND audit.completed_at >= ${range.from} AND audit.completed_at < ${range.to}) AS cross_audits_completed,
          count(DISTINCT corrective_action_submission.id)::int AS actions_submitted,
          avg(extract(epoch FROM (corrective_action_submission.created_at - corrective_action.opened_at)) / 3600)
            FILTER (WHERE corrective_action_submission.id IS NOT NULL) AS average_response_hours,
          greatest(max(corrective_action_submission.created_at), max(corrective_action.updated_at)) AS last_active_at
        FROM "user"
        LEFT JOIN corrective_action
          ON corrective_action.assigned_zone_leader_user_id = "user".id
        LEFT JOIN corrective_action_submission
          ON corrective_action_submission.corrective_action_id = corrective_action.id
          AND corrective_action_submission.created_at >= ${range.from}
          AND corrective_action_submission.created_at < ${range.to}
        WHERE ${scopeSql} AND "user".role = 'ZONE_LEADER'
        GROUP BY "user".id, "user".full_name
        ORDER BY actions_submitted DESC, "user".full_name
      `);
      return result.rows;
    });
  }

  async syncHealth(scope: ScopeContext) {
    return this.inScope(scope, async (tx) => {
      const [row] = await tx
        .select({
          devices: sql<number>`count(DISTINCT ${deviceSyncRecords.deviceId})::int`,
          oldest: sql<Date | null>`min(${deviceSyncRecords.startedAt})`,
        })
        .from(deviceSyncRecords)
        .where(
          this.scoped(
            scope,
            { recordUserId: deviceSyncRecords.userId },
            sql`${deviceSyncRecords.status} <> 'COMPLETED'`,
          ),
        );
      return { devices: row?.devices ?? 0, oldest: row?.oldest ?? null };
    });
  }

  /** Rebuilds one Unit-local calendar day. Re-running it updates the same unique rows. */
  async rollupDay(scope: ScopeContext, unitId: string, timezone: string, day: string): Promise<void> {
    return this.inScope(scope, async (tx) => {
      const start = sql`(${day}::date::timestamp AT TIME ZONE ${timezone})`;
      const end = sql`((${day}::date + 1)::timestamp AT TIME ZONE ${timezone})`;
      const unitScope = this.scoped(scope, { unitId: audits.unitId }, eq(audits.unitId, unitId));

      const auditRows = await tx
        .select({
          id: audits.id,
          auditorUserId: audits.auditorUserId,
          rawScore: audits.rawScore,
          maxScore: audits.maxScore,
          scorePercentage: audits.totalScore,
        })
        .from(audits)
        .where(and(unitScope, completed(), gte(audits.completedAt, start), lt(audits.completedAt, end)));
      const created = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(audits)
        .where(and(unitScope, gte(audits.createdAt, start), lt(audits.createdAt, end)));
      const scoredAudits = auditRows.filter((row) => row.scorePercentage !== null && (row.maxScore ?? 0) > 0);
      const auditTotals = sumTotals(
        scoredAudits.map((row) => scorePart(row.rawScore ?? 0, row.maxScore ?? 0)),
      );

      const [actionMetrics] = await tx
        .select({
          openNc: sql<number>`count(*) FILTER (
            WHERE ${correctiveActions.openedAt} < ${end}
              AND (${correctiveActions.resolvedAt} IS NULL OR ${correctiveActions.resolvedAt} >= ${end})
          )::int`,
          closedNc: sql<number>`count(*) FILTER (
            WHERE ${correctiveActions.resolvedAt} >= ${start} AND ${correctiveActions.resolvedAt} < ${end}
          )::int`,
          avgClosureHours: sql<string | null>`avg(extract(epoch FROM (${correctiveActions.resolvedAt} - ${correctiveActions.openedAt})) / 3600)
            FILTER (WHERE ${correctiveActions.resolvedAt} >= ${start} AND ${correctiveActions.resolvedAt} < ${end})`,
        })
        .from(correctiveActions)
        .where(this.scoped(scope, { unitId: correctiveActions.unitId }, eq(correctiveActions.unitId, unitId)));

      const unitValues = {
        auditCount: created[0]?.count ?? 0,
        completedCount: auditRows.length,
        rawScore: auditTotals.rawScore,
        maxScore: auditTotals.maxScore,
        avgScore: auditTotals.scorePercentage?.toFixed(3) ?? null,
        scoreSampleCount: scoredAudits.length,
        openNc: actionMetrics?.openNc ?? 0,
        closedNc: actionMetrics?.closedNc ?? 0,
        avgClosureHours: actionMetrics?.avgClosureHours ?? null,
        activeAuditors: new Set(auditRows.map((row) => row.auditorUserId)).size,
      };
      await tx
        .insert(metricDailyUnits)
        .values({ unitId, day, ...unitValues })
        .onConflictDoUpdate({
          target: [metricDailyUnits.unitId, metricDailyUnits.day],
          set: unitValues,
          setWhere: sql`ROW(
            ${metricDailyUnits.auditCount}, ${metricDailyUnits.completedCount},
            ${metricDailyUnits.rawScore}, ${metricDailyUnits.maxScore}, ${metricDailyUnits.avgScore},
            ${metricDailyUnits.scoreSampleCount}, ${metricDailyUnits.openNc},
            ${metricDailyUnits.closedNc}, ${metricDailyUnits.avgClosureHours},
            ${metricDailyUnits.activeAuditors}
          ) IS DISTINCT FROM ROW(
            ${unitValues.auditCount}, ${unitValues.completedCount}, ${unitValues.rawScore},
            ${unitValues.maxScore}, ${unitValues.avgScore}, ${unitValues.scoreSampleCount},
            ${unitValues.openNc}, ${unitValues.closedNc}, ${unitValues.avgClosureHours},
            ${unitValues.activeAuditors}
          )`,
        });

      const zoneRows = await tx
        .select({
          zoneId: auditZones.zoneId,
          completedAt: auditZones.completedAt,
          rawScore: auditZones.rawScore,
          maxScore: auditZones.maxScore,
          scorePercentage: auditZones.scorePercentage,
        })
        .from(auditZones)
        .innerJoin(audits, eq(audits.id, auditZones.auditId))
        .where(and(unitScope, completed(), gte(auditZones.completedAt, start), lt(auditZones.completedAt, end)))
        .orderBy(desc(auditZones.completedAt));
      const unitZones = await tx
        .select({ id: zones.id })
        .from(zones)
        .where(this.scoped(scope, { unitId: zones.unitId }, eq(zones.unitId, unitId), isNull(zones.archivedAt)));
      const openByZone = await tx
        .select({ zoneId: correctiveActions.zoneId, count: sql<number>`count(*)::int` })
        .from(correctiveActions)
        .where(
          this.scoped(
            scope,
            { unitId: correctiveActions.unitId },
            eq(correctiveActions.unitId, unitId),
            lt(correctiveActions.openedAt, end),
            or(isNull(correctiveActions.resolvedAt), gte(correctiveActions.resolvedAt, end)),
          ),
        )
        .groupBy(correctiveActions.zoneId);
      const openMap = new Map(openByZone.map((row) => [row.zoneId, row.count]));

      for (const zone of unitZones) {
        const rows = zoneRows.filter((row) => row.zoneId === zone.id);
        const scored = rows.filter((row) => row.scorePercentage !== null && row.maxScore > 0);
        const totals = sumTotals(scored.map((row) => scorePart(row.rawScore, row.maxScore)));
        const values = {
          auditCount: rows.length,
          rawScore: totals.rawScore,
          maxScore: totals.maxScore,
          lastScore: scored[0]?.scorePercentage ?? null,
          avgScore: totals.scorePercentage?.toFixed(3) ?? null,
          scoreSampleCount: scored.length,
          openNc: openMap.get(zone.id) ?? 0,
        };
        await tx
          .insert(metricDailyZones)
          .values({ unitId, zoneId: zone.id, day, ...values })
          .onConflictDoUpdate({
            target: [metricDailyZones.zoneId, metricDailyZones.day],
            set: values,
            setWhere: sql`ROW(
              ${metricDailyZones.auditCount}, ${metricDailyZones.rawScore},
              ${metricDailyZones.maxScore}, ${metricDailyZones.lastScore},
              ${metricDailyZones.avgScore}, ${metricDailyZones.scoreSampleCount},
              ${metricDailyZones.openNc}
            ) IS DISTINCT FROM ROW(
              ${values.auditCount}, ${values.rawScore}, ${values.maxScore}, ${values.lastScore},
              ${values.avgScore}, ${values.scoreSampleCount}, ${values.openNc}
            )`,
          });
      }

      const sectionRows = await tx
        .select({
          zoneId: auditZones.zoneId,
          section: auditZoneSectionScores.section,
          rawScore: auditZoneSectionScores.rawScore,
          maxScore: auditZoneSectionScores.maxScore,
          scorePercentage: auditZoneSectionScores.scorePercentage,
        })
        .from(auditZoneSectionScores)
        .innerJoin(auditZones, eq(auditZones.id, auditZoneSectionScores.auditZoneId))
        .innerJoin(audits, eq(audits.id, auditZones.auditId))
        .where(and(unitScope, completed(), gte(auditZones.completedAt, start), lt(auditZones.completedAt, end)));

      for (const zone of unitZones) {
        for (const section of S_SECTION_ORDER) {
          const rows = sectionRows.filter(
            (row) => row.zoneId === zone.id && row.section === section && row.scorePercentage !== null,
          );
          const totals = sumTotals(rows.map((row) => scorePart(row.rawScore, row.maxScore)));
          const values = {
            rawScore: totals.rawScore,
            maxScore: totals.maxScore,
            avgScorePercentage: totals.scorePercentage?.toFixed(3) ?? null,
            sampleCount: rows.length,
          };
          await tx
            .insert(metricSectionDaily)
            .values({ unitId, zoneId: zone.id, section, day, ...values })
            .onConflictDoUpdate({
              target: [
                metricSectionDaily.unitId,
                metricSectionDaily.zoneId,
                metricSectionDaily.section,
                metricSectionDaily.day,
              ],
              set: values,
              setWhere: sql`ROW(
                ${metricSectionDaily.rawScore}, ${metricSectionDaily.maxScore},
                ${metricSectionDaily.avgScorePercentage}, ${metricSectionDaily.sampleCount}
              ) IS DISTINCT FROM ROW(
                ${values.rawScore}, ${values.maxScore}, ${values.avgScorePercentage},
                ${values.sampleCount}
              )`,
            });
        }
      }
    });
  }
}
