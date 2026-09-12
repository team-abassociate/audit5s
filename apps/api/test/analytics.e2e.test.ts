import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UnitSections, UnitTrend, ZoneRankingItem } from '@audit5s/contracts';
import { AnalyticsRollupWorker } from '../src/modules/analytics/analytics-rollup.worker';
import { startWorld, stopWorld, type TestWorld } from './harness';

let world: TestWorld;
let superAdmin: string;
let coordinator: string;
const base = '/api/v1/analytics';

beforeAll(async () => {
  world = await startWorld();
  superAdmin = world.actors.SUPER_ADMIN.accessToken;
  coordinator = world.actors.COORDINATOR.accessToken;
  await seedKnownAnswers();

  const rollup = world.app.get(AnalyticsRollupWorker);
  for (const now of ['2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z', '2026-02-03T00:00:00.000Z']) {
    await rollup.handle({ unitId: world.unitA, timezone: 'Asia/Kolkata' }, new Date(now));
  }
}, 180_000);

afterAll(async () => stopWorld(world));

describe('Phase 8 analytics', () => {
  it('buckets by Unit timezone, not UTC', async () => {
    const { rows } = await world.owner.query(
      `SELECT day::text, completed_count FROM metric_daily_unit
       WHERE unit_id = $1 ORDER BY day`,
      [world.unitA],
    );
    expect(rows).toEqual([
      { day: '2026-01-31', completed_count: 0 },
      { day: '2026-02-01', completed_count: 2 },
      { day: '2026-02-02', completed_count: 1 },
    ]);
  });

  it('uses Σraw/Σmax, excludes walk-bys, and suppresses low-sample ranks', async () => {
    const trend = await world.request('GET', `${base}/units/${world.unitA}/trend`, { token: coordinator });
    expect(trend.status).toBe(200);
    const february = (trend.body as UnitTrend).points.find((point) => point.period === '2026-02');
    expect(february).toMatchObject({ scorePercentage: 60, sampleCount: 2, auditCount: 3 });

    const ranking = await world.request('GET', `${base}/units/${world.unitA}/zones/ranking`, { token: coordinator });
    expect(ranking.status).toBe(200);
    expect((ranking.body as ZoneRankingItem[])[0]).toMatchObject({
      rank: null,
      score: { scorePercentage: 60, sampleCount: 2 },
      auditCount: 3,
    });
  });

  it('keeps fully-NA sections null and out of averages', async () => {
    const response = await world.request('GET', `${base}/units/${world.unitA}/sections`, { token: coordinator });
    expect(response.status).toBe(200);
    const data = response.body as UnitSections;
    expect(data.radar.find((row) => row.section === 'S3_SHINE')).toMatchObject({
      currentScorePercentage: null,
      previousScorePercentage: null,
      sampleCount: 0,
    });
    expect(data.trend.find((row) => row.section === 'S3_SHINE')).toMatchObject({
      scorePercentage: null,
      sampleCount: 0,
    });
  });

  it('finds recurrent questions and includes walk-bys in activity', async () => {
    const recurrent = await world.request(
      'GET',
      `${base}/units/${world.unitA}/nonconformities/recurrent`,
      { token: coordinator },
    );
    expect(recurrent.status).toBe(200);
    expect(recurrent.body).toEqual([
      expect.objectContaining({ questionText: 'Floor is clear', failureCount: 2 }),
    ]);

    const activity = await world.request('GET', `${base}/activity/me`, {
      token: world.actors.CONSULTANT.accessToken,
    });
    expect(activity.status).toBe(200);
    expect(activity.body).toMatchObject({ auditsCompleted: 3, zonesCovered: 1 });
  });

  it('is row-identical when the same rollup runs twice', async () => {
    const before = await allRollups();
    const rollup = world.app.get(AnalyticsRollupWorker);
    await rollup.handle(
      { unitId: world.unitA, timezone: 'Asia/Kolkata' },
      new Date('2026-02-02T00:00:00.000Z'),
    );
    expect(await allRollups()).toEqual(before);
  });

  it('enforces organization, own-Unit and own-record permissions', async () => {
    expect((await world.request('GET', `${base}/organization/overview`, { token: superAdmin })).status).toBe(200);
    expect((await world.request('GET', `${base}/organization/overview`, { token: coordinator })).status).toBe(403);
    expect((await world.request('GET', `${base}/units/${world.unitB}/overview`, { token: coordinator })).status).toBe(404);
    expect((await world.request('GET', `${base}/activity/me`, { token: world.actors.CONSULTANT.accessToken })).status).toBe(200);
  });

  it('keeps dashboard p95 below 500 ms on two years of rollups', async () => {
    await seedTwoYears();
    const range = '?from=2024-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z';
    const paths = ['overview', `trend${range}`, `sections${range}`, `zones/ranking${range}`];
    const timings: number[] = [];
    for (let run = 0; run < 8; run += 1) {
      for (const path of paths) {
        const started = performance.now();
        const response = await world.request('GET', `${base}/units/${world.unitA}/${path}`, { token: coordinator });
        expect(response.status).toBe(200);
        timings.push(performance.now() - started);
      }
    }
    timings.sort((a, b) => a - b);
    expect(timings[Math.ceil(timings.length * 0.95) - 1]).toBeLessThan(500);
  });
});

async function allRollups() {
  const { rows } = await world.owner.query(
    `SELECT * FROM (
       SELECT 'unit' AS kind, to_jsonb(metric_daily_unit) AS row FROM metric_daily_unit
       UNION ALL SELECT 'zone', to_jsonb(metric_daily_zone) FROM metric_daily_zone
       UNION ALL SELECT 'section', to_jsonb(metric_section_daily) FROM metric_section_daily
     ) rollups
     ORDER BY kind, row->>'day', row->>'zone_id', row->>'section'`,
  );
  return rows;
}

async function seedKnownAnswers() {
  const templateId = randomUUID();
  const versionId = randomUUID();
  const questionIds = [randomUUID(), randomUUID(), randomUUID()];
  await world.owner.query(
    `INSERT INTO checklist_template (id, code, name, sort_order)
     VALUES ($1, 'ANALYTICS', 'Analytics', 1)`,
    [templateId],
  );
  await world.owner.query(
    `INSERT INTO checklist_version (id, template_id, version_number, status, total_questions,
       questions_per_section, content_hash, published_at)
     VALUES ($1, $2, 1, 'DRAFT', 50, 10, 'analytics-v1', NULL)`,
    [versionId, templateId],
  );
  for (const [index, questionId] of questionIds.entries()) {
    await world.owner.query(
      `INSERT INTO checklist_question (id, version_id, section, order_in_section, global_order, text)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [
        questionId,
        versionId,
        index < 2 ? 'S1_SORT' : 'S2_SET_IN_ORDER',
        index + 1,
        index === 2 ? 'Floor is clear' : `Analytics question ${index + 1}`,
      ],
    );
  }
  await world.owner.query(
    `UPDATE checklist_version SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [versionId],
  );

  await insertAudit(versionId, questionIds, {
    completedAt: '2026-01-31T20:00:00.000Z',
    values: ['SCORE_2', 'SCORE_2', 'SCORE_0'],
    raw: 4,
    max: 6,
    score: '66.667',
  });
  await insertAudit(versionId, questionIds, {
    completedAt: '2026-02-01T20:00:00.000Z',
    values: ['SCORE_2', 'NA', 'SCORE_0'],
    raw: 2,
    max: 4,
    score: '50.000',
  });

  const auditId = randomUUID();
  await world.owner.query(
    `INSERT INTO audit (id, unit_id, audit_type, status, auditor_user_id, started_at, completed_at)
     VALUES ($1, $2, 'WALK_BY', 'CLOSED', $3, $4::timestamptz - interval '20 minutes', $4)`,
    [auditId, world.unitA, world.actors.CONSULTANT.userId, '2026-01-31T21:00:00.000Z'],
  );
  await world.owner.query(
    `INSERT INTO audit_zone (id, audit_id, zone_id, sequence_no, status,
       zone_code_snapshot, zone_name_snapshot, completed_at)
     VALUES (gen_random_uuid(), $1, $2, 1, 'COMPLETED', 'Z-01', 'Press', $3)`,
    [auditId, world.zoneA, '2026-01-31T21:00:00.000Z'],
  );
}

async function insertAudit(
  versionId: string,
  questionIds: string[],
  fixture: { completedAt: string; values: string[]; raw: number; max: number; score: string },
) {
  const auditId = randomUUID();
  const auditZoneId = randomUUID();
  await world.owner.query(
    `INSERT INTO audit (id, unit_id, audit_type, status, auditor_user_id, checklist_version_id,
       started_at, completed_at, raw_score, max_score, applicable_questions, na_questions, total_score)
     VALUES ($1, $2, 'EXTERNAL_5S', 'IN_PROGRESS', $3, $4,
       $5::timestamptz - interval '30 minutes', $5, $6, $7, $8, $9, $10)`,
    [auditId, world.unitA, world.actors.CONSULTANT.userId, versionId, fixture.completedAt,
      fixture.raw, fixture.max, fixture.max / 2, fixture.values.filter((value) => value === 'NA').length, fixture.score],
  );
  await world.owner.query(
    `INSERT INTO audit_zone (id, audit_id, zone_id, sequence_no, status,
       zone_code_snapshot, zone_name_snapshot, checklist_version_id,
       checklist_template_name_snapshot, completed_at, raw_score, max_score,
       applicable_questions, na_questions, score_percentage)
     VALUES ($1, $2, $3, 1, 'IN_PROGRESS', 'Z-01', 'Press', $4, 'Analytics', $5,
       $6, $7, $8, $9, $10)`,
    [auditZoneId, auditId, world.zoneA, versionId, fixture.completedAt, fixture.raw, fixture.max,
      fixture.max / 2, fixture.values.filter((value) => value === 'NA').length, fixture.score],
  );
  for (const [index, value] of fixture.values.entries()) {
    await world.owner.query(
      `INSERT INTO question_response (id, audit_zone_id, audit_id, checklist_question_id,
       section, global_order, value, numeric_score, answered_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [auditZoneId, auditId, questionIds[index], index < 2 ? 'S1_SORT' : 'S2_SET_IN_ORDER',
        index + 1, value, value === 'NA' ? null : value === 'SCORE_2' ? 2 : 0, fixture.completedAt],
    );
  }
  await world.owner.query(
    `INSERT INTO audit_zone_section_score
       (audit_zone_id, section, applicable_questions, na_questions, raw_score, max_score, score_percentage)
     VALUES ($1, 'S1_SORT', $2, $3, $4, $5, $6),
            ($1, 'S2_SET_IN_ORDER', 1, 0, 0, 2, 0),
            ($1, 'S3_SHINE', 0, 1, 0, 0, NULL)`,
    [auditZoneId, fixture.values[1] === 'NA' ? 1 : 2, fixture.values[1] === 'NA' ? 1 : 0,
      2 + (fixture.values[1] === 'SCORE_2' ? 2 : 0), fixture.values[1] === 'NA' ? 2 : 4, '100.000'],
  );
  await world.owner.query(`UPDATE audit_zone SET status = 'COMPLETED' WHERE id = $1`, [auditZoneId]);
  await world.owner.query(`UPDATE audit SET status = 'CLOSED' WHERE id = $1`, [auditId]);
}

async function seedTwoYears() {
  await world.owner.query(
    `INSERT INTO metric_daily_unit
       (unit_id, day, completed_count, raw_score, max_score, avg_score, score_sample_count)
     SELECT $1, day::date, 1, 8, 10, 80, 1
     FROM generate_series('2024-01-01'::date, '2025-12-30'::date, interval '1 day') day
     ON CONFLICT (unit_id, day) DO NOTHING`,
    [world.unitA],
  );
  await world.owner.query(
    `INSERT INTO metric_daily_zone
       (unit_id, zone_id, day, audit_count, raw_score, max_score, last_score, avg_score, score_sample_count)
     SELECT $1, $2, day::date, 1, 8, 10, 80, 80, 1
     FROM generate_series('2024-01-01'::date, '2025-12-30'::date, interval '1 day') day
     ON CONFLICT (zone_id, day) DO NOTHING`,
    [world.unitA, world.zoneA],
  );
  await world.owner.query(
    `INSERT INTO metric_section_daily
       (unit_id, zone_id, section, day, raw_score, max_score, avg_score_percentage, sample_count)
     SELECT $1, $2, section::s_section, day::date, 8, 10, 80, 1
     FROM generate_series('2024-01-01'::date, '2025-12-30'::date, interval '1 day') day
     CROSS JOIN unnest(enum_range(NULL::s_section)) section
     ON CONFLICT (unit_id, zone_id, section, day) DO NOTHING`,
    [world.unitA, world.zoneA],
  );
}
