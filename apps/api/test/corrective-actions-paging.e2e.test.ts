import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  CORRECTIVE_ACTION_GROUPS,
  CORRECTIVE_ACTION_SORTS,
  type CorrectiveAction,
  type CorrectiveActionSummary,
  type Page,
  type Role,
} from '@audit5s/contracts';
import { loginFromDevice, startWorld, stopWorld, type TestWorld } from './harness';
import { completedWalkBy } from './corrective-fixtures';

/**
 * CA10: the corrective-action queue sorted, grouped and counted on the server, so a
 * screen that pages through it never has to count or order the rows it happens to hold.
 *
 * What this pins: every sort × group walks the whole queue a page at a time with no row
 * skipped or repeated, in exactly the order one big page has; a group's rows are
 * contiguous, so a group that runs onto the next page continues there; the summary counts
 * the same rows the list returns — for each of the four roles, inside their own scope.
 */

let world: TestWorld;
const base = API_BASE_PATH;
const DEVICE = '01930000-0000-7000-8000-0000000ca10e';
let consultant: string;
const tokenOf = (role: Role) => (role === 'CONSULTANT' ? consultant : world.actors[role].accessToken);

beforeAll(async () => {
  world = await startWorld();
  consultant = await loginFromDevice(world, world.actors.CONSULTANT, DEVICE);
  await world.owner.query(
    `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id) VALUES ($1, $2, 'CONSULTANT', $1)`,
    [world.actors.CONSULTANT.userId, world.unitB],
  );
  const walk = (unitB: boolean, leader: string | null, nonconformities: number) =>
    completedWalkBy(world, {
      token: consultant,
      deviceId: DEVICE,
      unitId: unitB ? world.unitB : world.unitA,
      zoneLeaderUserId: leader,
      nonconformities,
    });
  const leader = world.actors.ZONE_LEADER.userId;
  const first = await walk(false, leader, 4);
  const typed = await walk(false, null, 3);
  const third = await walk(false, leader, 2);
  const other = await walk(true, world.outOfScopeUserId, 3);

  // A Zone whose leader is only a typed name (R-19), and no leader on the action.
  await world.owner.query(`UPDATE zone SET zone_leader_name = 'Tara Typed' WHERE id = $1`, [typed.zoneId]);
  await world.owner.query(`UPDATE corrective_action SET assigned_zone_leader_user_id = NULL WHERE zone_id = $1`, [typed.zoneId]);
  // Overdue, awaiting review, settled and undated — every key the order has to place.
  const [a, b, c, d] = first.actions;
  await world.owner.query(`UPDATE corrective_action SET due_at = now() - interval '3 days' WHERE id = ANY($1)`, [
    [a!.id, typed.actions[0]!.id, other.actions[0]!.id],
  ]);
  await world.owner.query(`UPDATE corrective_action SET status = 'NOT_POSSIBLE' WHERE id = $1`, [b!.id]);
  await world.owner.query(`UPDATE corrective_action SET status = 'ACTION_SUBMITTED' WHERE id = $1`, [third.actions[0]!.id]);
  await world.owner.query(`UPDATE corrective_action SET status = 'VERIFIED', resolved_at = now() WHERE id = $1`, [c!.id]);
  await world.owner.query(`UPDATE corrective_action SET due_at = NULL WHERE id = $1`, [d!.id]);
}, 300_000);

afterAll(async () => {
  await stopWorld(world);
});

async function page(token: string, query: string): Promise<Page<CorrectiveAction>> {
  const response = await world.request('GET', `${base}/corrective-actions?${query}`, { token });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as Page<CorrectiveAction>;
}

async function walkAll(token: string, query: string, limit: number): Promise<CorrectiveAction[]> {
  const rows: CorrectiveAction[] = [];
  let cursor: string | null = null;
  do {
    const next: Page<CorrectiveAction> = await page(
      token,
      `${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    rows.push(...next.data);
    cursor = next.nextCursor;
  } while (cursor);
  return rows;
}

async function summary(token: string, query = ''): Promise<CorrectiveActionSummary> {
  const response = await world.request('GET', `${base}/corrective-actions/summary?${query}`, { token });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as CorrectiveActionSummary;
}

const leaderOf = (a: CorrectiveAction) => a.assignedZoneLeaderName ?? a.zoneLeaderName ?? null;
const groupKey = (group: string, a: CorrectiveAction) =>
  group === 'audit' ? `${a.unitId}|${a.auditId}` : `${a.unitId}|${a.zoneId}|${leaderOf(a) ?? ''}`;

describe('GET /corrective-actions — server order and cursor (CA10)', () => {
  const combos = [
    ...CORRECTIVE_ACTION_SORTS.flatMap((sort) => [
      `sort=${sort}`,
      ...CORRECTIVE_ACTION_GROUPS.map((group) => `sort=${sort}&group=${group}`),
    ]),
    ...CORRECTIVE_ACTION_GROUPS.map((group) => `group=${group}`),
  ];

  it.each(combos)('%s: pages of 2 walk exactly the one-page order, nothing skipped or repeated', async (query) => {
    const sa = world.actors.SUPER_ADMIN.accessToken;
    const whole = (await page(sa, `${query}&limit=200`)).data;
    expect(whole).toHaveLength(12);
    const paged = await walkAll(sa, query, 2);
    expect(paged.map((a) => a.id)).toEqual(whole.map((a) => a.id));

    const group = new URLSearchParams(query).get('group');
    if (group) {
      // Contiguous: once a group ends it never appears again, so it shows one header.
      const runs = paged.map((a) => groupKey(group, a)).filter((key, i, keys) => key !== keys[i - 1]);
      expect(new Set(runs).size).toBe(runs.length);
    }
  });

  it('due: everything awaiting an answer first, soonest due first, undated last of them', async () => {
    const rows = (await page(world.actors.SUPER_ADMIN.accessToken, `sort=due&unitId=${world.unitA}&limit=200`)).data;
    const live = (a: CorrectiveAction) => a.status === 'OPEN' || a.status === 'REOPENED';
    const firstSettled = rows.findIndex((a) => !live(a));
    expect(rows.slice(firstSettled).every((a) => !live(a))).toBe(true);
    const dues = rows.slice(0, firstSettled).map((a) => a.dueAt ?? '9999');
    expect(dues).toEqual([...dues].sort());
    expect(rows[0]!.dueAt! < new Date().toISOString()).toBe(true);
  });

  it('leader: by who to chase, the typed Zone leader included, unnamed last', async () => {
    const rows = (await page(world.actors.SUPER_ADMIN.accessToken, `sort=leader&limit=200`)).data;
    const names = rows.map(leaderOf);
    expect(names).toContain('Tara Typed');
    const named = names.filter((n): n is string => n !== null);
    expect(names.slice(0, named.length)).toEqual(named);
  });

  it('without a sort or group the order is still the id’s — what an installed field app reads', async () => {
    const rows = (await page(world.actors.SUPER_ADMIN.accessToken, 'limit=200')).data.map((a) => a.id);
    expect(rows).toEqual([...rows].sort());
    const paged = (await walkAll(world.actors.SUPER_ADMIN.accessToken, 'overdue=false', 5)).map((a) => a.id);
    expect(paged).toEqual(rows);
  });

  it('refuses a malformed cursor, sort or group with 422, not a server error', async () => {
    const sa = world.actors.SUPER_ADMIN.accessToken;
    for (const query of ['sort=due&cursor=nope', 'cursor=nope', 'sort=zone', 'group=owner']) {
      const response = await world.request('GET', `${base}/corrective-actions?${query}`, { token: sa });
      expect(response.status, query).toBe(422);
    }
  });

  it('awaitingReview finds a "not possible" and a submission, and nothing else', async () => {
    const rows = await walkAll(world.actors.SUPER_ADMIN.accessToken, 'awaitingReview=true&sort=due', 1);
    expect(rows.map((a) => a.status).sort()).toEqual(['ACTION_SUBMITTED', 'NOT_POSSIBLE']);
  });
});

describe('GET /corrective-actions/summary (CA10)', () => {
  it('counts exactly the rows the list returns, for each filter', async () => {
    const sa = world.actors.SUPER_ADMIN.accessToken;
    for (const query of ['', `unitId=${world.unitA}`, 'overdue=true', 'awaitingReview=true', 'status=OPEN']) {
      const rows = await walkAll(sa, `sort=due&${query}`, 3);
      const totals = await summary(sa, query);
      expect(totals.total, query).toBe(rows.length);
      const now = Date.now();
      const late = rows.filter(
        (a) => (a.status === 'OPEN' || a.status === 'REOPENED') && a.dueAt !== null && Date.parse(a.dueAt) < now,
      );
      expect(totals.overdue, query).toBe(late.length);
      for (const [status, n] of Object.entries(totals.byStatus)) {
        expect(n, `${query} ${status}`).toBe(rows.filter((a) => a.status === status).length);
      }
      expect(totals.byAudit.reduce((sum, g) => sum + g.total, 0), query).toBe(rows.length);
      for (const g of totals.byZoneLeader) {
        const members = rows.filter((a) => groupKey('leader', a) === `${g.unitId}|${g.zoneId}|${g.leader ?? ''}`);
        expect(g.total, `${query} ${g.zoneCode}`).toBe(members.length);
      }
    }
    const all = await summary(sa);
    expect(all.byZoneLeader.find((g) => g.leader === 'Tara Typed')?.overdue).toBe(1);
    expect(all.byStatus).toMatchObject({ NOT_POSSIBLE: 1, ACTION_SUBMITTED: 1, VERIFIED: 1 });
  });

  it.each(['SUPER_ADMIN', 'CONSULTANT', 'COORDINATOR', 'ZONE_LEADER'] as const)(
    '%s: summary and sorted list agree, inside the role’s own scope',
    async (role) => {
      const token = tokenOf(role);
      const rows = await walkAll(token, 'sort=leader&group=leader', 4);
      const totals = await summary(token);
      expect(totals.total).toBe(rows.length);
      const units = new Set(rows.map((a) => a.unitId));
      // A Coordinator and a Zone Leader see Unit A alone; the Consultant both Units' audits.
      expect([...units].sort()).toEqual(
        role === 'COORDINATOR' || role === 'ZONE_LEADER' ? [world.unitA] : [world.unitA, world.unitB].sort(),
      );
      // Naming another Unit narrows; it never widens past scope.
      const outside = await summary(token, `unitId=${world.unitB}`);
      expect(outside.total).toBe(role === 'COORDINATOR' || role === 'ZONE_LEADER' ? 0 : 3);
    },
  );

  it('refuses without a session', async () => {
    const response = await world.request('GET', `${base}/corrective-actions/summary`, { token: null });
    expect(response.status).toBe(401);
  });
});
