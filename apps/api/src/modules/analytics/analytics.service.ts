import { Injectable } from '@nestjs/common';
import type {
  AnalyticsActivityQuery,
  AnalyticsRangeQuery,
  AnalyticsRankingQuery,
  AnalyticsTrendQuery,
  ClosureAnalytics,
  ClosureBreakdown,
  ConsultantActivity,
  OrganizationOverview,
  RecurrentNonconformity,
  ScoreMetric,
  SSection,
  UnitOverview,
  UnitSections,
  UnitTrend,
  ZoneLeaderActivity,
  ZoneRankingItem,
} from '@audit5s/contracts';
import { S_SECTION_ORDER, sumTotals, type ScopeContext, type ScoreTotals } from '@audit5s/domain';
import { QueueService } from '../../infrastructure/queue/queue.service';
import { AppError } from '../../common/errors';
import { AnalyticsRepository, type AnalyticsRange } from './analytics.repository';

type DailyUnit = Awaited<ReturnType<AnalyticsRepository['dailyUnits']>>[number];
type ClosureRow = Awaited<ReturnType<AnalyticsRepository['closure']>>[number];

const number = (value: unknown): number => Number(value ?? 0);
const nullableNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === 'string' ? new Date(value).toISOString() : null;
const totals = (rawScore: number, maxScore: number): ScoreTotals => ({
  applicableQuestions: 0,
  naQuestions: 0,
  rawScore,
  maxScore,
  scorePercentage: null,
});

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly repository: AnalyticsRepository,
    private readonly queue: QueueService,
  ) {}

  async organizationOverview(
    scope: ScopeContext,
    query: AnalyticsRangeQuery,
  ): Promise<OrganizationOverview> {
    const range = toRange(query);
    const [rows, units, activeAuditors, closureRows, sync, failedJobs] = await Promise.all([
      this.repository.dailyUnits(scope, range),
      this.repository.unitRows(scope),
      this.repository.activeAuditors(scope, range),
      this.repository.closure(scope, range),
      this.repository.syncHealth(scope),
      this.queue.failedCount(),
    ]);
    const closure = aggregateClosure(closureRows);
    const latestOpen = latestPer(rows, (row) => row.unitId).reduce((sum, row) => sum + row.openNc, 0);

    return {
      ...overviewTotals(rows),
      openNonconformities: latestOpen,
      closureRatePercentage: closure.closureRatePercentage,
      averageClosureHours: closure.averageClosureHours,
      activeAuditors,
      unitRanking: rankUnits(rows, units, query.minSamples),
      syncHealth: {
        devicesWithUnsyncedData: sync.devices,
        deadLetterCount: failedJobs,
        oldestPendingAt: sync.oldest?.toISOString() ?? null,
      },
    };
  }

  async unitOverview(
    scope: ScopeContext,
    unitId: string,
    query: AnalyticsRangeQuery,
  ): Promise<UnitOverview> {
    await this.assertUnit(scope, unitId);
    const range = toRange(query);
    const [rows, activeAuditors, zoneCount, closureRows] = await Promise.all([
      this.repository.dailyUnits(scope, range, unitId),
      this.repository.activeAuditors(scope, range, unitId),
      this.repository.zoneCount(scope, unitId),
      this.repository.closure(scope, range, unitId),
    ]);
    const base = overviewTotals(rows);
    const closure = aggregateClosure(closureRows);
    return {
      unitId,
      ...base,
      zoneCount,
      openNonconformities: rows.at(-1)?.openNc ?? 0,
      closureRatePercentage: closure.closureRatePercentage,
      averageClosureHours: closure.averageClosureHours,
      activeAuditors,
    };
  }

  async trend(scope: ScopeContext, unitId: string, query: AnalyticsTrendQuery): Promise<UnitTrend> {
    await this.assertUnit(scope, unitId);
    const range = toRange(query);
    const [rows, history] = await Promise.all([
      this.repository.dailyUnits(scope, range, unitId),
      this.repository.zoneScoreHistory(scope, range, unitId),
    ]);
    const buckets = group(rows, (row) =>
      query.granularity === 'month' ? row.day.slice(0, 7) : row.day,
    );
    const points = [...buckets.entries()].map(([period, values]) => {
      const score = scoreOf(values);
      return { period, ...score, auditCount: values.reduce((sum, row) => sum + row.completedCount, 0) };
    });

    return {
      unitId,
      granularity: query.granularity,
      points,
      zones: [...group(history, (row) => row.zoneId).entries()].map(([, values]) => ({
        zoneId: values[0]!.zoneId,
        zoneCode: values[0]!.zoneCode,
        zoneName: values[0]!.zoneName,
        points: values.map((row, index) => {
          const scorePercentage = Number(row.scorePercentage);
          const previous = index > 0 ? Number(values[index - 1]!.scorePercentage) : null;
          return {
            completedAt: row.completedAt!.toISOString(),
            scorePercentage,
            improvement: previous === null ? null : scorePercentage - previous,
          };
        }),
      })),
    };
  }

  async sections(
    scope: ScopeContext,
    unitId: string,
    query: AnalyticsRangeQuery,
  ): Promise<UnitSections> {
    await this.assertUnit(scope, unitId);
    const range = toRange(query);
    const [rows, latest] = await Promise.all([
      this.repository.dailySections(scope, range, unitId),
      this.repository.latestSections(scope, unitId),
    ]);
    const trend = [...group(rows, (row) => `${row.day.slice(0, 7)}|${row.section}`).entries()].map(
      ([key, values]) => {
        const score = scoreOf(values);
        return {
          period: key.slice(0, 7),
          section: values[0]!.section,
          scorePercentage: score.scorePercentage,
          sampleCount: score.sampleCount,
        };
      },
    );
    return {
      unitId,
      radar: S_SECTION_ORDER.map((section) => ({
        section,
        currentScorePercentage: latestScore(latest, section, 1),
        previousScorePercentage: latestScore(latest, section, 2),
        sampleCount: rows.filter((row) => row.section === section).reduce((sum, row) => sum + row.sampleCount, 0),
      })),
      trend,
    };
  }

  async ranking(
    scope: ScopeContext,
    unitId: string,
    query: AnalyticsRankingQuery,
  ): Promise<ZoneRankingItem[]> {
    await this.assertUnit(scope, unitId);
    const range = toRange(query);
    const [daily, history, weak, open] = await Promise.all([
      this.repository.dailyZones(scope, range, unitId),
      this.repository.zoneScoreHistory(scope, range, unitId),
      this.repository.weakSectionsByZone(scope, range, unitId),
      this.repository.openNonconformitiesByZone(scope, unitId),
    ]);
    const historyByZone = group(history, (row) => row.zoneId);
    const weakByZone = group(weak, (row) => row.zone_id);
    const openByZone = new Map(open.map((row) => [row.zoneId, row.count]));
    const items = [...group(daily, (row) => row.row.zoneId).entries()].map(([zoneId, values]) => {
      const score = scoreOf(values.map((value) => value.row));
      const scores = historyByZone.get(zoneId) ?? [];
      const last = scores.at(-1);
      const previous = scores.at(-2);
      const weakSection = [...(weakByZone.get(zoneId) ?? [])].sort(
        (a, b) => number(a.raw_score) / number(a.max_score) - number(b.raw_score) / number(b.max_score),
      )[0];
      const lastAuditAt = iso(last?.completedAt);
      const item: ZoneRankingItem = {
        zoneId,
        zoneCode: values[0]!.zoneCode,
        zoneName: values[0]!.zoneName,
        rank: null,
        score,
        lastScore: nullableNumber(last?.scorePercentage),
        previousScore: nullableNumber(previous?.scorePercentage),
        improvement:
          last && previous ? Number(last.scorePercentage) - Number(previous.scorePercentage) : null,
        auditCount: values.reduce((sum, value) => sum + value.row.auditCount, 0),
        lastAuditAt,
        daysSinceLastAudit: lastAuditAt
          ? Math.max(0, Math.floor((Date.now() - Date.parse(lastAuditAt)) / 86_400_000))
          : null,
        dominantWeakSection: weakSection?.section ?? null,
        openNonconformities: openByZone.get(zoneId) ?? 0,
      };
      return item;
    });
    items.sort((a, b) =>
      query.order === 'best'
        ? (b.score.scorePercentage ?? -1) - (a.score.scorePercentage ?? -1)
        : (a.score.scorePercentage ?? 101) - (b.score.scorePercentage ?? 101),
    );
    let rank = 0;
    for (const item of items) if (item.score.sampleCount >= query.minSamples) item.rank = ++rank;
    return items.slice(0, query.limit);
  }

  async recurrent(
    scope: ScopeContext,
    unitId: string,
    query: AnalyticsRangeQuery,
  ): Promise<RecurrentNonconformity[]> {
    await this.assertUnit(scope, unitId);
    return (await this.repository.recurrent(scope, toRange(query), unitId)).map((row) => ({
      checklistQuestionId: row.checklist_question_id,
      questionText: row.question_text,
      section: row.section,
      zoneId: row.zone_id,
      zoneCode: row.zone_code,
      zoneName: row.zone_name,
      failureCount: number(row.failure_count),
      lastSeenAt: iso(row.last_seen_at)!,
    }));
  }

  async closure(
    scope: ScopeContext,
    query: AnalyticsActivityQuery,
  ): Promise<ClosureAnalytics> {
    if (query.unitId) await this.assertUnit(scope, query.unitId);
    const rows = await this.repository.closure(scope, toRange(query), query.unitId);
    const total = aggregateClosure(rows);
    return {
      ...total,
      byUnit: closureBreakdowns(rows, 'unit_id', 'unit_name'),
      byZone: closureBreakdowns(rows, 'zone_id', 'zone_name'),
      byLeader: closureBreakdowns(rows, 'leader_id', 'leader_name'),
    };
  }

  async consultants(scope: ScopeContext, query: AnalyticsActivityQuery): Promise<ConsultantActivity[]> {
    if (query.unitId) await this.assertUnit(scope, query.unitId);
    return (await this.repository.consultantActivity(scope, toRange(query), query.unitId)).map(toConsultant);
  }

  async zoneLeaders(scope: ScopeContext, query: AnalyticsActivityQuery): Promise<ZoneLeaderActivity[]> {
    if (query.unitId) await this.assertUnit(scope, query.unitId);
    return (await this.repository.zoneLeaderActivity(scope, toRange(query), query.unitId)).map(toLeader);
  }

  async ownActivity(scope: ScopeContext, query: AnalyticsRangeQuery) {
    const range = toRange(query);
    if (scope.actor.role === 'CONSULTANT') {
      const rows = await this.repository.consultantActivity(scope, range, undefined, true);
      return rows[0] ? toConsultant(rows[0]) : null;
    }
    if (scope.actor.role === 'ZONE_LEADER') {
      const rows = await this.repository.zoneLeaderActivity(scope, range, undefined, true);
      return rows[0] ? toLeader(rows[0]) : null;
    }
    return null;
  }

  private async assertUnit(scope: ScopeContext, unitId: string): Promise<void> {
    if (!(await this.repository.unitRows(scope)).some((unit) => unit.id === unitId)) {
      throw AppError.notFound('Unit not found');
    }
  }
}

export function toRange(query: Pick<AnalyticsRangeQuery, 'from' | 'to'>): AnalyticsRange {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), to.getUTCDate()));
  return { from, to, fromDay: from.toISOString().slice(0, 10), toDay: to.toISOString().slice(0, 10) };
}

function scoreOf(rows: Array<{ rawScore: number; maxScore: number; scoreSampleCount?: number; sampleCount?: number }>): ScoreMetric {
  const score = sumTotals(rows.map((row) => totals(row.rawScore, row.maxScore)));
  return {
    rawScore: score.rawScore,
    maxScore: score.maxScore,
    scorePercentage: score.scorePercentage,
    sampleCount: rows.reduce((sum, row) => sum + (row.scoreSampleCount ?? row.sampleCount ?? 0), 0),
  };
}

function overviewTotals(rows: DailyUnit[]) {
  return {
    auditCount: rows.reduce((sum, row) => sum + row.completedCount, 0),
    completedCount: rows.reduce((sum, row) => sum + row.completedCount, 0),
    score: scoreOf(rows),
    closedNonconformities: rows.reduce((sum, row) => sum + row.closedNc, 0),
  };
}

function rankUnits(
  rows: DailyUnit[],
  units: Array<{ id: string; code: string; name: string }>,
  minSamples: number,
) {
  const items = units.map((unit) => ({
    unitId: unit.id,
    unitCode: unit.code,
    unitName: unit.name,
    rank: null as number | null,
    score: scoreOf(rows.filter((row) => row.unitId === unit.id)),
  }));
  items.sort((a, b) => (b.score.scorePercentage ?? -1) - (a.score.scorePercentage ?? -1));
  let rank = 0;
  for (const item of items) if (item.score.sampleCount >= minSamples) item.rank = ++rank;
  return items;
}

function latestPer<T extends { day: string }>(rows: T[], key: (row: T) => string): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) if (!latest.has(key(row)) || latest.get(key(row))!.day < row.day) latest.set(key(row), row);
  return [...latest.values()];
}

function group<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}

function latestScore(
  rows: Array<{ section: SSection; score_percentage: string | null; ordinal: number }>,
  section: SSection,
  ordinal: number,
): number | null {
  return nullableNumber(rows.find((row) => row.section === section && row.ordinal === ordinal)?.score_percentage);
}

function aggregateClosure(rows: ClosureRow[]) {
  const opened = rows.reduce((sum, row) => sum + number(row.opened), 0);
  const submitted = rows.reduce((sum, row) => sum + number(row.submitted), 0);
  const resolved = rows.reduce((sum, row) => sum + number(row.resolved), 0);
  const closureHours = rows.reduce((sum, row) => sum + number(row.avg_closure_hours) * number(row.resolved), 0);
  return {
    opened,
    submitted,
    resolved,
    closureRatePercentage: opened === 0 ? null : (resolved / opened) * 100,
    averageClosureHours: resolved === 0 ? null : closureHours / resolved,
  };
}

function closureBreakdowns(
  rows: ClosureRow[],
  idKey: 'unit_id' | 'zone_id' | 'leader_id',
  labelKey: 'unit_name' | 'zone_name' | 'leader_name',
): ClosureBreakdown[] {
  const usable = rows.filter((row) => row[idKey]);
  return [...group(usable, (row) => String(row[idKey])).entries()].map(([id, values]) => ({
    id,
    label: String(values[0]![labelKey]),
    ...aggregateClosure(values),
  }));
}

function toConsultant(row: Record<string, unknown>): ConsultantActivity {
  return {
    userId: String(row.user_id),
    fullName: String(row.full_name),
    auditsCompleted: number(row.audits_completed),
    zonesCovered: number(row.zones_covered),
    photosCaptured: number(row.photos_captured),
    averageDurationMinutes: nullableNumber(row.average_duration_minutes),
    lastActiveAt: iso(row.last_active_at),
  };
}

function toLeader(row: Record<string, unknown>): ZoneLeaderActivity {
  return {
    userId: String(row.user_id),
    fullName: String(row.full_name),
    crossAuditsCompleted: number(row.cross_audits_completed),
    actionsSubmitted: number(row.actions_submitted),
    averageResponseHours: nullableNumber(row.average_response_hours),
    lastActiveAt: iso(row.last_active_at),
  };
}
