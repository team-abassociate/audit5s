import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  API_BASE_PATH,
  type Audit,
  type AuditAssignment,
  type AuditDetail,
  type AuditScoreSummary,
  type AuditZone,
  type CorrectiveAction,
  type Page,
  type ResponseValue,
  type ZoneLocksResponse,
} from '@audit5s/contracts';
import { S_SECTION_ORDER, TOTAL_QUESTIONS, scoreZone } from '@audit5s/domain';
import {
  FIXTURE_PASSWORD,
  captureEvidence,
  loginFromDevice,
  startWorld,
  stopWorld,
  type TestWorld,
} from './harness';
import { RateLimitService } from '../src/common/rate-limit/rate-limit.service';

/**
 * The audit engine (PART 14, Phase 3 tests row).
 *
 * Everything the authorization matrix marks `coveredBy: 'audits.e2e.test.ts'` is exercised
 * here, plus the four behaviours the roadmap names by hand: the idempotent response upsert,
 * the device-ownership 409, snapshot isolation, and the state machine refusing an illegal
 * move through the API rather than only in a unit test.
 */

let world: TestWorld;
const base = API_BASE_PATH;

/** The Consultant's device and the Zone Leader's, so D7 has two writers to arbitrate. */
/** Rate limits are per-process and per login ID: a suite that signs in repeatedly would
 *  otherwise trip §12.11's lockout on itself, which is the control working, not a flake. */
function resetLimits(): void {
  world.app.get(RateLimitService).reset();
}

/** The Consultant the harness creates. R-29's refusal names whoever holds the Zone. */
const CONSULTANT_NAME = 'Cara Consult';

const CONSULTANT_DEVICE = '01930000-0000-7000-8000-00000000d001';
const OTHER_DEVICE = '01930000-0000-7000-8000-00000000d002';
const LEADER_DEVICE = '01930000-0000-7000-8000-00000000d003';

let consultantToken: string;
let otherDeviceToken: string;
let leaderToken: string;
let versionId: string;
let questionIds: string[];

beforeAll(async () => {
  world = await startWorld();

  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, CONSULTANT_DEVICE);
  otherDeviceToken = await loginFromDevice(world, world.actors.CONSULTANT, OTHER_DEVICE);
  leaderToken = await loginFromDevice(world, world.actors.ZONE_LEADER, LEADER_DEVICE);

  ({ versionId, questionIds } = await seedPublishedChecklist());
}, 120_000);

afterAll(async () => {
  await stopWorld(world);
});

const asSuperAdmin = () => world.actors.SUPER_ADMIN.accessToken;

/**
 * A published fifty-question checklist, written directly.
 *
 * The importer has its own suite; what these tests need is a *pinned version to answer*,
 * and building it through six pipeline stages would make every failure here ambiguous.
 */
async function seedPublishedChecklist(): Promise<{ versionId: string; questionIds: string[] }> {
  const { rows: templateRows } = await world.owner.query(
    `INSERT INTO checklist_template (code, name, sort_order)
     VALUES ('SHOP_FLOOR', 'Shop Floor', 0) RETURNING id`,
  );
  const { rows: versionRows } = await world.owner.query(
    `INSERT INTO checklist_version (template_id, version_number, total_questions, content_hash)
     VALUES ($1, 1, 50, 'audits-e2e-v1') RETURNING id`,
    [templateRows[0].id],
  );
  const version = versionRows[0].id as string;

  const ids: string[] = [];
  for (const [sectionIndex, section] of S_SECTION_ORDER.entries()) {
    for (let order = 1; order <= 10; order += 1) {
      const globalOrder = sectionIndex * 10 + order;
      const { rows } = await world.owner.query(
        `INSERT INTO checklist_question (version_id, section, order_in_section, global_order, text)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [version, section, order, globalOrder, `Question ${globalOrder}`],
      );
      ids.push(rows[0].id as string);
    }
  }

  await world.owner.query(
    `UPDATE checklist_version SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [version],
  );

  return { versionId: version, questionIds: ids };
}

async function createZone(code: string, name: string, description: string | null = null) {
  const response = await world.request('POST', `${base}/units/${world.unitA}/zones`, {
    token: asSuperAdmin(),
    body: { code, name, ...(description ? { description } : {}) },
  });
  expect(response.status).toBe(201);
  return (response.body as { id: string }).id;
}

async function assign(auditorUserId: string, unitId = world.unitA) {
  const response = await world.request('POST', `${base}/audit-assignments`, {
    token: asSuperAdmin(),
    body: { unitId, auditorUserId, auditType: 'EXTERNAL_5S' },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as AuditAssignment;
}

/**
 * A Consultant with **no** `unit_membership` — R-28's independent master list, which is
 * what the field actually has. The harness's fixture Consultant holds a permanent
 * membership in Unit A, so every assignment-scoped effect is invisible through them.
 */
let unboundCount = 0;
async function unboundConsultant(): Promise<{
  userId: string;
  loginId: string;
  token: string;
  deviceId: string;
}> {
  unboundCount += 1;
  const suffix = String(9000 + unboundCount);
  const loginId = `UB${suffix}`;
  const deviceId = `01930000-0000-7000-8000-0000000${suffix}f`;

  const argon2 = await import('argon2');
  const { ARGON2_OPTIONS } = await import('../src/modules/auth/password.service');
  const { rows } = await world.owner.query(
    `INSERT INTO "user" (login_id, full_name, phone_e164, role, password_hash,
                         must_reset_password, status)
     VALUES ($1, $2, $3, 'CONSULTANT', $4, false, 'ACTIVE') RETURNING id`,
    [
      loginId,
      `Unbound Consult ${unboundCount}`,
      `+9190000${suffix}`,
      await argon2.hash(FIXTURE_PASSWORD, ARGON2_OPTIONS),
    ],
  );

  resetLimits();
  const token = await loginFromDevice(
    world,
    {
      role: 'CONSULTANT',
      userId: rows[0].id as string,
      loginId,
      accessToken: '',
      refreshToken: '',
      unitId: null,
    },
    deviceId,
  );

  return { userId: rows[0].id as string, loginId, token, deviceId };
}

/** Creates an audit, adds one Zone, and returns both ids. */
async function startAuditWithZone(options: {
  token: string;
  deviceId: string;
  zoneId: string;
  assignmentId?: string;
  auditType?: 'EXTERNAL_5S' | 'CROSS_5S';
  sequenceNo?: number;
}) {
  const auditId = randomUUID();
  const created = await world.request('POST', `${base}/audits`, {
    token: options.token,
    body: {
      id: auditId,
      auditType: options.auditType ?? 'EXTERNAL_5S',
      unitId: world.unitA,
      checklistVersionId: versionId,
      deviceId: options.deviceId,
      ...(options.assignmentId ? { assignmentId: options.assignmentId } : {}),
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  // Phase 4 made §7.1's `selfie_captured` guard real, so an audit reaches READY only once
  // a live-captured `AUDITOR_SELFIE` exists for it. The selfie is taken *after* the audit
  // row exists, because `evidence.audit_id` is a foreign key — which is why this sits
  // between creation and start rather than before both.
  await captureEvidence(world, {
    token: options.token,
    evidenceId: randomUUID(),
    auditId,
    kind: 'AUDITOR_SELFIE',
    deviceId: options.deviceId,
  });

  const started = await world.request('POST', `${base}/audits/${auditId}/start`, {
    token: options.token,
    body: { deviceId: options.deviceId },
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);

  const auditZoneId = randomUUID();
  const zone = await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
    token: options.token,
    body: {
      zoneId: options.zoneId,
      sequenceNo: options.sequenceNo ?? 1,
      checklistVersionId: versionId,
    },
  });
  expect(zone.status, JSON.stringify(zone.body)).toBe(200);

  return { auditId, auditZoneId, zone: zone.body as AuditZone };
}

/** Answers `values[i]` to question i, in order, one request per answer as a device does. */
async function answer(
  token: string,
  auditZoneId: string,
  values: readonly ResponseValue[],
): Promise<void> {
  for (const [index, value] of values.entries()) {
    const response = await world.request(
      'PUT',
      `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`,
      {
        token,
        body: {
          checklistQuestionId: questionIds[index],
          value,
          answeredAt: new Date().toISOString(),
        },
      },
    );
    expect(response.status, `question ${index + 1}: ${JSON.stringify(response.body)}`).toBe(200);
  }
}

/** A fifty-answer pattern with a deliberate mix, including three NAs. */
function fiftyAnswers(): ResponseValue[] {
  const values: ResponseValue[] = [];
  for (let index = 0; index < TOTAL_QUESTIONS; index += 1) {
    if (index === 12 || index === 27 || index === 44) values.push('NA');
    else if (index % 7 === 0) values.push('SCORE_0');
    else if (index % 3 === 0) values.push('SCORE_1');
    else values.push('SCORE_2');
  }
  return values;
}

describe('assignments', () => {
  it('grants a Consultant temporary Unit access through the assignment', async () => {
    const response = await world.request('POST', `${base}/audit-assignments`, {
      token: asSuperAdmin(),
      body: {
        unitId: world.unitB,
        auditorUserId: world.actors.CONSULTANT.userId,
        auditType: 'EXTERNAL_5S',
      },
    });
    expect(response.status).toBe(201);

    const catalogue = await world.request('GET', `${base}/sync/catalogue`, {
      token: consultantToken,
    });
    expect(catalogue.status).toBe(200);
    const body = catalogue.body as {
      units: Array<{ id: string }>;
      zones: Array<{ unitId: string }>;
      assignments: AuditAssignment[];
    };
    expect(body.units.map((unit) => unit.id)).toContain(world.unitB);
    expect(body.zones.some((zone) => zone.unitId === world.unitB)).toBe(true);
    expect(body.assignments.map((assignment) => assignment.id)).toContain(
      (response.body as AuditAssignment).id,
    );

    const cancelled = await world.request(
      'POST',
      `${base}/audit-assignments/${(response.body as AuditAssignment).id}/cancel`,
      { token: asSuperAdmin(), body: { reason: 'Temporary access test complete' } },
    );
    expect(cancelled.status).toBe(200);

    const after = await world.request('GET', `${base}/sync/catalogue`, {
      token: consultantToken,
    });
    expect(
      (after.body as { units: Array<{ id: string }> }).units.map((unit) => unit.id),
    ).not.toContain(world.unitB);
  });

  it('shows a Consultant only their own assignments (own_record, "assignee only")', async () => {
    await assign(world.actors.CONSULTANT.userId);
    await assign(world.actors.ZONE_LEADER.userId);

    const response = await world.request('GET', `${base}/audit-assignments`, {
      token: consultantToken,
    });
    expect(response.status).toBe(200);
    const page = response.body as Page<AuditAssignment>;
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data.every((item) => item.auditorUserId === world.actors.CONSULTANT.userId)).toBe(
      true,
    );
  });

  it('cancels rather than deletes, and records the reason', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const response = await world.request(
      'POST',
      `${base}/audit-assignments/${assignment.id}/cancel`,
      { token: asSuperAdmin(), body: { reason: 'Plant shutdown' } },
    );
    expect(response.status).toBe(200);
    expect((response.body as AuditAssignment).status).toBe('CANCELLED');
    expect((response.body as AuditAssignment).cancelReason).toBe('Plant shutdown');

    // Still readable. Cancellation is a status, never a removal.
    const read = await world.request('GET', `${base}/audit-assignments/${assignment.id}`, {
      token: asSuperAdmin(),
    });
    expect(read.status).toBe(200);
  });

  /**
   * The field report behind 0027: a Consultant reassigned to a Unit finished an audit and
   * the phone said "Scores not available" on a score the server had already computed —
   * `POST /audits/{id}/complete` answered `404 No such audit` *after* completing it.
   *
   * Completing an audit closes its assignment, which is right (R-28: the grant is
   * temporary). What was wrong is that `unit_select` admitted a Unit only through
   * `app_actor_unit_ids()`, and every audit read `INNER JOIN`s `unit` for its name — so
   * the audit became unreadable to the person who had just conducted it.
   *
   * **This needs a Consultant with no `unit_membership`.** The harness gives the fixture
   * Consultant a permanent one in Unit A, so for them the assignment closing changes
   * nothing and the whole suite sailed past this in production.
   */
  it('lets a Consultant who holds the Unit by assignment alone read the audit back after it closes', async () => {
    const { userId, token, deviceId } = await unboundConsultant();
    const assignment = await assign(userId);
    const zoneId = await createZone('Z-91', 'Assignment-only zone');

    const { auditId, auditZoneId } = await startAuditWithZone({
      token,
      deviceId,
      zoneId,
      assignmentId: assignment.id,
    });
    const values = fiftyAnswers();
    await answer(token, auditZoneId, values);
    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token,
      body: {},
    });

    // The edge that closes the assignment, and used to 404 on its own success.
    const completed = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token,
      body: {},
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    // The assignment really did close: this is not the fix quietly keeping it open.
    const closed = await world.request('GET', `${base}/audit-assignments/${assignment.id}`, {
      token: asSuperAdmin(),
    });
    expect((closed.body as AuditAssignment).status).toBe('COMPLETED');

    // The Scores screen (§8.6, N6).
    const expected = scoreZone(
      values.map((value, index) => ({ section: S_SECTION_ORDER[Math.floor(index / 10)]!, value })),
    );
    const summary = await world.request('GET', `${base}/audits/${auditId}/summary`, { token });
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect((summary.body as AuditScoreSummary).audit.totals.scorePercentage).toBe(
      expected.totals.scorePercentage,
    );

    // …and the History list it was reached from.
    const list = await world.request('GET', `${base}/audits?limit=100`, { token });
    expect((list.body as Page<Audit>).data.map((audit) => audit.id)).toContain(auditId);

    // What did *not* widen: the Unit master is still only the Units they currently hold,
    // and a closed assignment still cannot start another audit there.
    const catalogue = await world.request('GET', `${base}/sync/catalogue`, { token });
    expect(
      (catalogue.body as { units: Array<{ id: string }> }).units.map((unit) => unit.id),
    ).not.toContain(world.unitA);

    const again = await world.request('POST', `${base}/audits`, {
      token,
      body: {
        id: randomUUID(),
        auditType: 'EXTERNAL_5S',
        unitId: world.unitA,
        checklistVersionId: versionId,
        deviceId,
      },
    });
    // 404 rather than 403: the Unit is out of scope for the write, so it is not found
    // rather than forbidden. What matters is that it is still refused.
    expect(again.status).toBe(404);
  });

  /*
   * Field report, 2026-09-23: three audits of one Unit on one assignment. Finishing the
   * second closed the assignment, the Unit left the Consultant's scope, and the next Zone
   * of the first — still open on the same phone — was refused as "No such audit", which
   * Sync health shows as "Access was revoked mid-audit".
   */
  it('keeps the Unit for an open audit when another audit on the same assignment finishes', async () => {
    const { userId, token, deviceId } = await unboundConsultant();
    const assignment = await assign(userId);

    // Both audits pick up the one open assignment, as the phone's audits do: it sends none.
    const first = await startAuditWithZone({
      token,
      deviceId,
      zoneId: await createZone('Z-93', 'First audit zone'),
    });
    const second = await startAuditWithZone({
      token,
      deviceId,
      zoneId: await createZone('Z-94', 'Second audit zone'),
    });
    for (const audit of [first, second]) {
      const read = await world.request('GET', `${base}/audits/${audit.auditId}`, { token });
      expect((read.body as Audit).assignmentId).toBe(assignment.id);
    }

    await answer(token, second.auditZoneId, fiftyAnswers());
    await world.request('POST', `${base}/audits/${second.auditId}/zones/${second.auditZoneId}/complete`, {
      token,
      body: {},
    });
    const finished = await world.request('POST', `${base}/audits/${second.auditId}/complete`, {
      token,
      body: {},
    });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);

    // The assignment stays open while the first audit is still being conducted under it.
    const stillOpen = await world.request('GET', `${base}/audit-assignments/${assignment.id}`, {
      token: asSuperAdmin(),
    });
    expect((stillOpen.body as AuditAssignment).status).toBe('IN_PROGRESS');

    // The first audit's next Zone, named by number as the phone names it.
    const nextZoneId = randomUUID();
    const next = await world.request('PUT', `${base}/audits/${first.auditId}/zones/${nextZoneId}`, {
      token,
      body: { zoneNumber: 71, sequenceNo: 2, checklistVersionId: versionId, zoneLeaderName: 'A Leader' },
    });
    expect(next.status, JSON.stringify(next.body)).toBe(200);

    // And the Unit is still on the phone's catalogue while that audit is open.
    const catalogue = await world.request('GET', `${base}/sync/catalogue`, { token });
    expect(
      (catalogue.body as { units: Array<{ id: string }> }).units.map((unit) => unit.id),
    ).toContain(world.unitA);

    // Finishing the last open audit on the assignment closes it after all.
    for (const auditZoneId of [first.auditZoneId, nextZoneId]) {
      await answer(token, auditZoneId, fiftyAnswers());
      const done = await world.request(
        'POST',
        `${base}/audits/${first.auditId}/zones/${auditZoneId}/complete`,
        { token, body: {} },
      );
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    }
    const last = await world.request('POST', `${base}/audits/${first.auditId}/complete`, {
      token,
      body: {},
    });
    expect(last.status, JSON.stringify(last.body)).toBe(200);
    const closed = await world.request('GET', `${base}/audit-assignments/${assignment.id}`, {
      token: asSuperAdmin(),
    });
    expect((closed.body as AuditAssignment).status).toBe('COMPLETED');
  });

  it('appears in the device catalogue while open and disappears once cancelled', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);

    const before = await world.request('GET', `${base}/sync/catalogue`, { token: consultantToken });
    const openIds = (before.body as { assignments: AuditAssignment[] }).assignments.map((a) => a.id);
    expect(openIds).toContain(assignment.id);

    await world.request('POST', `${base}/audit-assignments/${assignment.id}/cancel`, {
      token: asSuperAdmin(),
      body: { reason: 'Rescheduled' },
    });

    const after = await world.request('GET', `${base}/sync/catalogue`, { token: consultantToken });
    const stillOpen = (after.body as { assignments: AuditAssignment[] }).assignments.map((a) => a.id);
    expect(stillOpen).not.toContain(assignment.id);
  });
});

describe('creating an audit', () => {
  it('starts an external audit with no open assignment, unassigned (R-20)', async () => {
    // Every assignment made so far is either cancelled or belongs to someone else, except
    // the ones this suite opened; cancel them so the absence is the only variable.
    const open = await world.request('GET', `${base}/audit-assignments?open=true&limit=200`, {
      token: asSuperAdmin(),
    });
    for (const assignment of (open.body as Page<AuditAssignment>).data) {
      await world.request('POST', `${base}/audit-assignments/${assignment.id}/cancel`, {
        token: asSuperAdmin(),
        body: { reason: 'Clearing the board for a test' },
      });
    }

    const response = await world.request('POST', `${base}/audits`, {
      token: consultantToken,
      body: {
        id: randomUUID(),
        auditType: 'EXTERNAL_5S',
        unitId: world.unitA,
        deviceId: CONSULTANT_DEVICE,
      },
    });
    // Access to the Unit is enough; the audit simply fulfils no assignment.
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect((response.body as Audit).assignmentId).toBeNull();
  });

  it('lets a Zone Leader start a CROSS_5S in their own Unit with no assignment (D9, N4)', async () => {
    const zoneId = await createZone('Z-31', 'Leader cross zone');
    const auditId = randomUUID();
    const response = await world.request('POST', `${base}/audits`, {
      token: leaderToken,
      body: {
        id: auditId,
        auditType: 'CROSS_5S',
        unitId: world.unitA,
        checklistVersionId: versionId,
        deviceId: LEADER_DEVICE,
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect((response.body as Audit).auditType).toBe('CROSS_5S');
    expect(zoneId).toBeTruthy();
  });

  it('refuses a Zone Leader an EXTERNAL_5S — a cell they hold no grant for', async () => {
    const response = await world.request('POST', `${base}/audits`, {
      token: leaderToken,
      body: {
        id: randomUUID(),
        auditType: 'EXTERNAL_5S',
        unitId: world.unitA,
        deviceId: LEADER_DEVICE,
      },
    });
    expect(response.status).toBe(403);
  });

  it('refuses a first login that names a device without saying what it is', async () => {
    // `refresh_token.device_id` references `device`, and the row is only written when a
    // platform arrives — so an unknown id with no platform issued a token pointing at a
    // device that does not exist, and the insert broke the foreign key. A well-formed
    // request answered 500. It is a 422 naming the missing field now, and it is what
    // holds the invariant the audit path leans on: a session is never bound to a device
    // with no row behind it.
    resetLimits();
    const login = await world.request('POST', `${base}/auth/login`, {
      body: {
        loginId: world.actors.CONSULTANT.loginId,
        password: FIXTURE_PASSWORD,
        deviceId: randomUUID(),
      },
    });

    expect(login.status, JSON.stringify(login.body)).toBe(422);
    expect(JSON.stringify(login.body)).toMatch(/platform/i);
  });

  it('still lets a known device sign in again without repeating its metadata', async () => {
    // The other half, and the one the Phase 1 acceptance walk relies on: after the first
    // login has registered the phone, a re-login carries the id alone. The model recorded
    // the first time must survive it.
    const known = randomUUID();
    resetLimits();
    await loginFromDevice(world, world.actors.CONSULTANT, known);

    resetLimits();
    const again = await world.request('POST', `${base}/auth/login`, {
      body: {
        loginId: world.actors.CONSULTANT.loginId,
        password: FIXTURE_PASSWORD,
        deviceId: known,
      },
    });

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const { rows } = await world.owner.query(
      `SELECT model, platform FROM device WHERE id = $1`,
      [known],
    );
    expect(rows[0].model).toBe('Pixel 8');
    expect(rows[0].platform).toBe('android');
  });

  it('lets both people on a shared handset start audits (0025)', async () => {
    // Signing in on a phone somebody else uses adds you to it; it does not take it from
    // them. The first person's session keeps working — this used to be a 422.
    const handset = randomUUID();
    resetLimits();
    const firstToken = await loginFromDevice(world, world.actors.CONSULTANT, handset);
    resetLimits();
    await loginFromDevice(world, world.actors.ZONE_LEADER, handset);

    await assign(world.actors.CONSULTANT.userId);
    const response = await world.request('POST', `${base}/audits`, {
      token: firstToken,
      body: {
        id: randomUUID(),
        auditType: 'EXTERNAL_5S',
        unitId: world.unitA,
        deviceId: handset,
      },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it('refuses a person whose place on the handset was withdrawn', async () => {
    const handset = randomUUID();
    resetLimits();
    const token = await loginFromDevice(world, world.actors.CONSULTANT, handset);
    await world.owner.query(
      `UPDATE device_user SET revoked_at = now() WHERE device_id = $1 AND user_id = $2`,
      [handset, world.actors.CONSULTANT.userId],
    );

    const response = await world.request('POST', `${base}/audits`, {
      token,
      body: { id: randomUUID(), auditType: 'EXTERNAL_5S', unitId: world.unitA, deviceId: handset },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/revoked/i);
  });

  it('returns the existing audit when the same client id is posted twice (§8.6 (a))', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const auditId = randomUUID();
    const body = {
      id: auditId,
      auditType: 'EXTERNAL_5S' as const,
      unitId: world.unitA,
      assignmentId: assignment.id,
      checklistVersionId: versionId,
      deviceId: CONSULTANT_DEVICE,
    };

    const first = await world.request('POST', `${base}/audits`, { token: consultantToken, body });
    expect(first.status).toBe(201);
    const second = await world.request('POST', `${base}/audits`, { token: consultantToken, body });
    expect(second.status).toBe(201);
    expect((second.body as Audit).id).toBe(auditId);

    const { rows } = await world.owner.query(`SELECT COUNT(*)::int AS n FROM audit WHERE id = $1`, [
      auditId,
    ]);
    expect(rows[0].n).toBe(1);
  });
});

describe('the single-writer lock (D7)', () => {
  it('gives a second device 409 DEVICE_NOT_OWNER on start', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-32', 'Contested zone');
    const { auditId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const response = await world.request('POST', `${base}/audits/${auditId}/start`, {
      token: otherDeviceToken,
      body: { deviceId: OTHER_DEVICE },
    });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('DEVICE_NOT_OWNER');
  });

  it('refuses a second device a response write on the same audit', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-33', 'Contested responses');
    const { auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const response = await world.request(
      'PUT',
      `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`,
      {
        token: otherDeviceToken,
        body: {
          checklistQuestionId: questionIds[0],
          value: 'SCORE_2',
          answeredAt: new Date().toISOString(),
        },
      },
    );
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('DEVICE_NOT_OWNER');
  });

  it('lets the owning device start again — idempotent, not a conflict', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-34', 'Restart zone');
    const { auditId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const again = await world.request('POST', `${base}/audits/${auditId}/start`, {
      token: consultantToken,
      body: { deviceId: CONSULTANT_DEVICE },
    });
    expect(again.status).toBe(200);
    expect((again.body as Audit).status).toBe('IN_PROGRESS');
  });
});

describe('question responses', () => {
  it('writes one row for the same payload sent five times', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-35', 'Idempotency zone');
    const { auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const payload = {
      checklistQuestionId: questionIds[0],
      value: 'SCORE_2' as const,
      remark: 'Racks labelled',
      answeredAt: new Date().toISOString(),
    };

    // Five different client ids for one question: the unique index, not the id, is what
    // makes the retry harmless.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await world.request(
        'PUT',
        `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`,
        { token: consultantToken, body: payload },
      );
      expect(response.status).toBe(200);
    }

    const { rows } = await world.owner.query(
      `SELECT COUNT(*)::int AS n FROM question_response WHERE audit_zone_id = $1`,
      [auditZoneId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('derives numeric_score from the enum, never from the client (QR-1)', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-36', 'QR-1 zone');
    const { auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    await answer(consultantToken, auditZoneId, ['SCORE_1', 'NA']);

    const { rows } = await world.owner.query(
      `SELECT value, numeric_score FROM question_response
       WHERE audit_zone_id = $1 ORDER BY global_order`,
      [auditZoneId],
    );
    expect(rows).toEqual([
      { value: 'SCORE_1', numeric_score: 1 },
      { value: 'NA', numeric_score: null },
    ]);
  });

  it('refuses a question from another checklist version (QR-2)', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-37', 'QR-2 zone');
    const { auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const { rows: otherTemplate } = await world.owner.query(
      `INSERT INTO checklist_template (code, name) VALUES ('OFFICE', 'Office') RETURNING id`,
    );
    const { rows: otherVersion } = await world.owner.query(
      `INSERT INTO checklist_version (template_id, version_number, total_questions, content_hash)
       VALUES ($1, 1, 50, 'other-v1') RETURNING id`,
      [otherTemplate[0].id],
    );
    const { rows: otherQuestion } = await world.owner.query(
      `INSERT INTO checklist_question (version_id, section, order_in_section, global_order, text)
       VALUES ($1, 'S1_SORT', 1, 1, 'A question from elsewhere') RETURNING id`,
      [otherVersion[0].id],
    );

    const response = await world.request(
      'PUT',
      `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`,
      {
        token: consultantToken,
        body: {
          checklistQuestionId: otherQuestion[0].id,
          value: 'SCORE_2',
          answeredAt: new Date().toISOString(),
        },
      },
    );
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('CHECKLIST_VERSION_MISMATCH');
  });

  it('moves the Zone DRAFT → IN_PROGRESS on the first answer, and tracks the cursor', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-38', 'Cursor zone');
    const { auditId, auditZoneId, zone } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });
    expect(zone.status).toBe('DRAFT');

    await answer(consultantToken, auditZoneId, ['SCORE_2', 'SCORE_1', 'SCORE_0']);

    const detail = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    const stored = (detail.body as AuditDetail).zones.find((z) => z.id === auditZoneId)!;
    expect(stored.status).toBe('IN_PROGRESS');
    expect(stored.resumeQuestionId).toBe(questionIds[2]);
  });
});

describe('finishing a Zone and an audit', () => {
  it('refuses to finish a Zone before every question of the pinned version is answered', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-39', 'Half-done zone');
    const { auditId, auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    await answer(consultantToken, auditZoneId, fiftyAnswers().slice(0, 49));

    const response = await world.request(
      'POST',
      `${base}/audits/${auditId}/zones/${auditZoneId}/complete`,
      { token: consultantToken, body: {} },
    );
    expect(response.status).toBe(409);
    const body = response.body as { code: string; detail?: string };
    expect(body.code).toBe('INVALID_STATE_TRANSITION');
    // The state machine's own reason survives into the problem document.
    expect(body.detail).toContain('all_questions_answered');
  });

  it('refuses to finish an audit whose Zones are not all complete', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-40', 'Unfinished audit');
    const { auditId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const response = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    expect(response.status).toBe(409);
    expect((response.body as { detail: string }).detail).toContain('all_zones_completed');
  });

  it('scores the Zone with the same function the device runs, and returns 200 twice', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-41', 'Scored zone');
    const { auditId, auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const values = fiftyAnswers();
    await answer(consultantToken, auditZoneId, values);

    const finished = await world.request(
      'POST',
      `${base}/audits/${auditId}/zones/${auditZoneId}/complete`,
      { token: consultantToken, body: { zoneRemark: 'Housekeeping improving' } },
    );
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);

    // The expected number comes from `packages/domain`, called here in the test process:
    // the API's answer must be that number, not merely close to it.
    const expected = scoreZone(
      values.map((value, index) => ({ section: S_SECTION_ORDER[Math.floor(index / 10)]!, value })),
    );
    const zone = finished.body as AuditZone;
    expect(zone.totals.scorePercentage).toBe(expected.totals.scorePercentage);
    expect(zone.totals.rawScore).toBe(expected.totals.rawScore);
    expect(zone.totals.maxScore).toBe(expected.totals.maxScore);
    expect(zone.totals.naQuestions).toBe(3);

    // Materialised per-S rows, written on this edge (§7.2).
    expect(zone.sections).toHaveLength(5);
    for (const [index, section] of zone.sections.entries()) {
      expect(section.pct).toBe(expected.sections[index]!.scorePercentage);
    }

    const completed = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    expect(completed.status).toBe(200);
    // No nonconformity photograph, so §7.1 rolls the completed audit straight to CLOSED.
    expect((completed.body as Audit).status).toBe('CLOSED');
    expect((completed.body as Audit).totals.scorePercentage).toBe(expected.totals.scorePercentage);

    // §8.6: a second call on a COMPLETED audit returns 200 with the same body.
    const again = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    expect(again.status).toBe(200);
    expect((again.body as Audit).completedAt).toBe((completed.body as Audit).completedAt);

    // …and the summary of §8.6 agrees, because it recomputes rather than reading a cache.
    const summary = await world.request('GET', `${base}/audits/${auditId}/summary`, {
      token: consultantToken,
    });
    expect(summary.status).toBe(200);
    const payload = summary.body as AuditScoreSummary;
    expect(payload.audit.totals.scorePercentage).toBe(expected.totals.scorePercentage);
    expect(payload.zones).toHaveLength(1);
    expect(payload.zones[0]!.sections.map((section) => section.section)).toEqual([
      ...S_SECTION_ORDER,
    ]);
  });

  /**
   * R-33 — the way back from an accidental *Finish audit*, and the cap that keeps it a
   * correction rather than an open door.
   *
   * The whole loop in one test, because the halves are only correct together: a restart
   * that did not restore the auditor's powers would be useless, and one that had no limit
   * would mean no audit is ever finished.
   */
  it('restarts a finished audit twice, restores the auditor’s powers, then refuses a third', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-95', 'Restart zone');
    const { auditId, auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });
    await answer(consultantToken, auditZoneId, fiftyAnswers());
    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token: consultantToken,
      body: {},
    });

    const finished = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect((finished.body as Audit).restartCount).toBe(0);
    expect((finished.body as Audit).restartsRemaining).toBe(2);

    // --- first restart ------------------------------------------------------
    const first = await world.request('POST', `${base}/audits/${auditId}/restart`, {
      token: consultantToken,
      body: { justification: 'Tapped finish before auditing the packing bay' },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const detail = first.body as AuditDetail;
    expect(detail.status).toBe('IN_PROGRESS');
    expect(detail.restartCount).toBe(1);
    expect(detail.restartsRemaining).toBe(1);
    // The Zones keep their own statuses: the auditor reopens what they need.
    expect(detail.zones[0]!.status).toBe('COMPLETED');

    // It was logged, with the reason and the count on either side.
    const { rows: logged } = await world.owner.query(
      `SELECT before, after FROM audit_log
       WHERE resource_id = $1 AND action = 'audit.restarted'`,
      [auditId],
    );
    expect(logged).toHaveLength(1);
    expect(logged[0].before).toMatchObject({ restartCount: 0 });
    expect(logged[0].after).toMatchObject({
      restartCount: 1,
      justification: 'Tapped finish before auditing the packing bay',
    });

    /*
     * The auditor's ordinary powers are back, and this is the assertion that matters.
     *
     * The response upsert is gated on the **audit's** status, not the Zone's — PART 6's
     * "audit must not be COMPLETED" — so a Zone still marked COMPLETED under a restarted
     * audit takes an ordinary mark, through the plain endpoint, with no justification and
     * no override. That is the whole point of returning the audit to IN_PROGRESS rather
     * than inventing a separate "restarted" flag: every rule that gates the auditor reads
     * one column, so restoring that column restores all of them at once.
     *
     * It rescores on the way, by the same Review-button path that already existed.
     */
    const corrected = await world.request(
      'PUT',
      `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`,
      {
        token: consultantToken,
        body: {
          // Question 2 was answered SCORE_2 by `fiftyAnswers`; dropping it to 0 is a
          // change the score has to show. (Question 1 is already a 0.)
          checklistQuestionId: questionIds[1],
          value: 'SCORE_0',
          answeredAt: new Date().toISOString(),
        },
      },
    );
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);

    const rescored = await world.request('GET', `${base}/audits/${auditId}/summary`, {
      token: consultantToken,
    });
    expect(rescored.status).toBe(200);
    expect((rescored.body as AuditScoreSummary).audit.totals.scorePercentage).not.toBe(
      (finished.body as Audit).totals.scorePercentage,
    );

    // --- second restart -----------------------------------------------------
    await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    const second = await world.request('POST', `${base}/audits/${auditId}/restart`, {
      token: consultantToken,
      body: { justification: 'One more correction on the dispatch Zone' },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect((second.body as AuditDetail).restartCount).toBe(2);
    expect((second.body as AuditDetail).restartsRemaining).toBe(0);

    // --- and no third -------------------------------------------------------
    await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    const third = await world.request('POST', `${base}/audits/${auditId}/restart`, {
      token: consultantToken,
      body: { justification: 'Hoping for a third bite at this audit' },
    });
    expect(third.status).toBe(409);
    expect((third.body as { code: string }).code).toBe('RESTART_LIMIT_REACHED');
  }, 240_000);

  it('refuses a restart with no justification, and one on an unfinished audit', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-96', 'Unfinished zone');
    const { auditId, auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    // Still IN_PROGRESS: there is nothing to restart.
    const early = await world.request('POST', `${base}/audits/${auditId}/restart`, {
      token: consultantToken,
      body: { justification: 'Nothing has finished yet' },
    });
    expect(early.status).toBe(409);
    expect((early.body as { code: string }).code).toBe('INVALID_STATE_TRANSITION');

    await answer(consultantToken, auditZoneId, fiftyAnswers());
    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token: consultantToken,
      body: {},
    });
    await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });

    // A-2's floor: a restart is a change to a finished audit and has to say why.
    const bare = await world.request('POST', `${base}/audits/${auditId}/restart`, {
      token: consultantToken,
      body: { justification: 'oops' },
    });
    expect(bare.status).toBe(422);
  }, 240_000);

  /**
   * The Review button's bug, in the terms the product owner reported it: a Consultant
   * changed a score on a finished Zone, saved, and every screen but their own kept the old
   * number. PART 6 allows the write until the audit is completed — what was missing was
   * the recomputation, because the materialised scores are written on the Zone's
   * completion edge and that edge does not fire twice.
   */
  it('rescores a finished Zone when a review changes an answer', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-63', 'Reviewed zone');
    const { auditId, auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const values = fiftyAnswers();
    await answer(consultantToken, auditZoneId, values);
    const finished = await world.request(
      'POST',
      `${base}/audits/${auditId}/zones/${auditZoneId}/complete`,
      { token: consultantToken, body: {} },
    );
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    const before = (finished.body as AuditZone).totals;

    // Question 1 was SCORE_0 in the pattern; the auditor reviews it and marks it a 2.
    expect(values[0]).toBe('SCORE_0');
    const revised = await world.request(
      'PUT',
      `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`,
      {
        token: consultantToken,
        body: {
          checklistQuestionId: questionIds[0],
          value: 'SCORE_2',
          answeredAt: new Date().toISOString(),
        },
      },
    );
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);

    const expected = scoreZone(
      values.map((value, index) => ({
        section: S_SECTION_ORDER[Math.floor(index / 10)]!,
        value: index === 0 ? ('SCORE_2' as ResponseValue) : value,
      })),
    );
    expect(expected.totals.rawScore).toBe(before.rawScore + 2);

    // `GET /audits/{id}` reads the **stored** columns, which is exactly what the Unit
    // board, analytics and the PDF read. Before the fix these still held `before`.
    const detail = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    expect(detail.status).toBe(200);
    const storedZone = (detail.body as AuditDetail).zones.find((z) => z.id === auditZoneId)!;
    expect(storedZone.totals.rawScore).toBe(expected.totals.rawScore);
    expect(storedZone.totals.scorePercentage).toBe(expected.totals.scorePercentage);
    expect((detail.body as AuditDetail).totals.scorePercentage).toBe(
      expected.totals.scorePercentage,
    );

    // The materialised per-S rows move with it: the report's radar reads these.
    const firstSection = storedZone.sections.find(
      (section) => section.section === S_SECTION_ORDER[0],
    )!;
    expect(firstSection.pct).toBe(expected.sections[0]!.scorePercentage);

    // The Zone stays finished through a review — reopening it is a Super Admin's edge.
    expect(storedZone.status).toBe('COMPLETED');

    // Pressing Submit again is the device's next item, and it must not undo any of this.
    const resubmitted = await world.request(
      'POST',
      `${base}/audits/${auditId}/zones/${auditZoneId}/complete`,
      { token: consultantToken, body: {} },
    );
    expect(resubmitted.status).toBe(200);
    expect((resubmitted.body as AuditZone).totals.rawScore).toBe(expected.totals.rawScore);
  });

  it('closes the audit to further answers once completed (A-2)', async () => {
    const { auditZoneId } = await completedAudit('Z-42', 'Frozen zone');

    const response = await world.request(
      'PUT',
      `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`,
      {
        token: consultantToken,
        body: {
          checklistQuestionId: questionIds[0],
          value: 'SCORE_0',
          answeredAt: new Date().toISOString(),
        },
      },
    );
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('AUDIT_ALREADY_COMPLETED');
  });
});

describe('abort and resume (N7, §9.8)', () => {
  it('saves the work, keeps the cursors, and resumes at the same question', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-43', 'Aborted zone');
    const { auditId, auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    await answer(consultantToken, auditZoneId, fiftyAnswers().slice(0, 23));

    const paused = await world.request('POST', `${base}/audits/${auditId}/pause`, {
      token: consultantToken,
      body: {
        reason: 'Shift ended',
        resumeAuditZoneId: auditZoneId,
        resumeQuestionId: questionIds[22],
      },
    });
    expect(paused.status).toBe(200);
    expect((paused.body as Audit).status).toBe('PAUSED');
    expect((paused.body as Audit).resumeAuditZoneId).toBe(auditZoneId);

    // Nothing was discarded. That is the whole of N7.
    const { rows } = await world.owner.query(
      `SELECT COUNT(*)::int AS n FROM question_response WHERE audit_zone_id = $1`,
      [auditZoneId],
    );
    expect(rows[0].n).toBe(23);

    const resumed = await world.request('POST', `${base}/audits/${auditId}/resume`, {
      token: consultantToken,
      body: { deviceId: CONSULTANT_DEVICE },
    });
    expect(resumed.status).toBe(200);
    expect((resumed.body as Audit).status).toBe('IN_PROGRESS');

    const detail = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    const stored = (detail.body as AuditDetail).zones.find((z) => z.id === auditZoneId)!;
    expect(stored.resumeQuestionId).toBe(questionIds[22]);
    expect(stored.responses).toHaveLength(23);
  });

  it('lets a Super Admin pause an audit and reach a resume, which still needs a device (7.1, R-18)', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-44', 'Admin paused');
    const { auditId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const paused = await world.request('POST', `${base}/audits/${auditId}/pause`, {
      token: asSuperAdmin(),
      body: { reason: 'Investigating a report' },
    });
    expect(paused.status).toBe(200);

    // R-18: `audit:resume` is his too, so no role refuses him. The single-writer lock (D7)
    // still does: a resume names the device that will own the audit, and this one names none.
    const resumed = await world.request('POST', `${base}/audits/${auditId}/resume`, {
      token: asSuperAdmin(),
      body: {},
    });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(422);
  });
});

describe('cancellation retains everything (A-1, D8)', () => {
  it('voids the audit and keeps its Zones and answers', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-45', 'Cancelled zone');
    const { auditId, auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });
    await answer(consultantToken, auditZoneId, ['SCORE_2', 'SCORE_1']);

    const cancelled = await world.request('POST', `${base}/audits/${auditId}/cancel`, {
      token: asSuperAdmin(),
      body: { reason: 'Duplicate visit' },
    });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as Audit).status).toBe('CANCELLED');

    const { rows } = await world.owner.query(
      `SELECT (SELECT COUNT(*) FROM audit_zone WHERE audit_id = $1)::int AS zones,
              (SELECT COUNT(*) FROM question_response WHERE audit_id = $1)::int AS responses`,
      [auditId],
    );
    expect(rows[0]).toEqual({ zones: 1, responses: 2 });

    const logged = await world.request(
      'GET',
      `${base}/audit-logs?action=audit.cancelled&resourceId=${auditId}`,
      { token: asSuperAdmin() },
    );
    expect((logged.body as Page<unknown>).data.length).toBeGreaterThan(0);
  });

  it('exposes no DELETE route for an audit, to anybody (D8)', () => {
    const instance = world.app.getHttpAdapter().getInstance() as {
      printRoutes: (options?: object) => string;
    };
    const routes = instance.printRoutes({ commonPrefix: false });
    // The router prints a method list per node; no node under /audits carries DELETE.
    for (const line of routes.split('\n')) {
      if (line.includes('DELETE')) {
        expect(line).not.toMatch(/audit/i);
      }
    }
  });
});

describe('snapshot isolation (D6)', () => {
  it('leaves a completed audit untouched when the Zone is renamed and re-described', async () => {
    const zoneId = await createZone('Z-46', 'Press', 'Press shop, bay 3');
    const { auditId, auditZoneId } = await completedAuditForZone(zoneId);

    const before = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    const beforeZone = (before.body as AuditDetail).zones.find((z) => z.id === auditZoneId)!;
    expect(beforeZone.zoneNameSnapshot).toBe('Press');
    expect(beforeZone.zoneDescriptionSnapshot).toBe('Press shop, bay 3');

    // Exactly what a Coordinator is meant to stay free to do, through the real endpoint.
    const edited = await world.request('PATCH', `${base}/zones/${zoneId}`, {
      token: asSuperAdmin(),
      body: { name: 'Press Shop (renamed)', description: 'Moved to bay 7 in June' },
    });
    expect(edited.status).toBe(200);

    const after = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    const afterZone = (after.body as AuditDetail).zones.find((z) => z.id === auditZoneId)!;
    expect(afterZone.zoneNameSnapshot).toBe('Press');
    expect(afterZone.zoneDescriptionSnapshot).toBe('Press shop, bay 3');
    expect(afterZone.totals).toEqual(beforeZone.totals);
    expect(afterZone.zoneCodeSnapshot).toBe('Z-46');
  });

  it('refuses to re-snapshot on a later upsert of the same audit Zone', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-47', 'Original name', 'Original description');
    const { auditId, auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    await world.request('PATCH', `${base}/zones/${zoneId}`, {
      token: asSuperAdmin(),
      body: { name: 'Changed mid-audit', description: 'Changed too' },
    });

    // A second upsert — the device saving a Zone remark — must not pick up the new name.
    const second = await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
      token: consultantToken,
      body: { zoneId, sequenceNo: 1, checklistVersionId: versionId, zoneRemark: 'Tidy' },
    });
    expect(second.status).toBe(200);
    expect((second.body as AuditZone).zoneNameSnapshot).toBe('Original name');
    expect((second.body as AuditZone).zoneRemark).toBe('Tidy');
  });

  /**
   * R-34 — the auditor may correct the Zone they named, while the audit is open.
   *
   * The companion to the test above, and the pair is the point: a *master* rename still
   * never reaches a snapshot, and the auditor's own correction now does. One of those is
   * D6's guarantee and the other was D6 being read wider than it said.
   */
  it('lets the auditor correct the Zone description and leader they typed, while open', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-97', 'Corrected zone', 'Typed in a hurry');
    const { auditId, auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const fixed = await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
      token: consultantToken,
      body: {
        zoneId,
        sequenceNo: 1,
        checklistVersionId: versionId,
        zoneDescription: 'Press shop, bay 7 — corrected on site',
        zoneLeaderName: 'R. Iyer',
      },
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect((fixed.body as AuditZone).zoneDescriptionSnapshot).toBe(
      'Press shop, bay 7 — corrected on site',
    );
    expect((fixed.body as AuditZone).zoneLeaderNameSnapshot).toBe('R. Iyer');

    // And once it is finished, the same correction is refused — the snapshot is history.
    await answer(consultantToken, auditZoneId, fiftyAnswers());
    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token: consultantToken,
      body: {},
    });
    await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });

    const late = await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
      token: consultantToken,
      body: {
        zoneId,
        sequenceNo: 1,
        checklistVersionId: versionId,
        zoneDescription: 'Changed after the fact',
      },
    });
    // Whether it is refused outright or accepted-but-ignored, the snapshot must not move.
    const after = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    const frozen = (after.body as AuditDetail).zones.find((zone) => zone.id === auditZoneId)!;
    expect(frozen.zoneDescriptionSnapshot).toBe('Press shop, bay 7 — corrected on site');
    expect([200, 409]).toContain(late.status);
  }, 180_000);

  it('refuses the same Zone twice in one audit', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-48', 'Duplicate zone');
    const { auditId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const response = await world.request('PUT', `${base}/audits/${auditId}/zones/${randomUUID()}`, {
      token: consultantToken,
      body: { zoneId, sequenceNo: 2, checklistVersionId: versionId },
    });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('ZONE_ALREADY_IN_AUDIT');
  });
});

describe('one Zone, one open audit (R-29)', () => {
  /**
   * The case the product owner named: one Unit, two auditors, the same morning. The
   * Consultant takes Zone 1; the Zone Leader running their own CROSS_5S must not be able
   * to take it too, and must be told who has it rather than getting a bare conflict.
   */
  it('refuses a Zone another open audit of the Unit is already holding', async () => {
    const zoneId = await createZone('Z-60', 'Contested zone');
    await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: (await assign(world.actors.CONSULTANT.userId)).id,
    });

    const secondAuditId = randomUUID();
    const created = await world.request('POST', `${base}/audits`, {
      token: leaderToken,
      body: {
        id: secondAuditId,
        auditType: 'CROSS_5S',
        unitId: world.unitA,
        checklistVersionId: versionId,
        deviceId: LEADER_DEVICE,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await captureEvidence(world, {
      token: leaderToken,
      evidenceId: randomUUID(),
      auditId: secondAuditId,
      kind: 'AUDITOR_SELFIE',
      deviceId: LEADER_DEVICE,
    });
    await world.request('POST', `${base}/audits/${secondAuditId}/start`, {
      token: leaderToken,
      body: { deviceId: LEADER_DEVICE },
    });

    const taken = await world.request(
      'PUT',
      `${base}/audits/${secondAuditId}/zones/${randomUUID()}`,
      {
        token: leaderToken,
        body: { zoneId, sequenceNo: 1, checklistVersionId: versionId },
      },
    );
    expect(taken.status, JSON.stringify(taken.body)).toBe(409);
    const problem = taken.body as { code: string; detail?: string };
    expect(problem.code).toBe('ZONE_LOCKED_BY_ANOTHER_AUDIT');
    // The sentence has to be actionable to someone standing in the plant, so it names
    // both the Zone and the colleague already in it.
    expect(problem.detail).toContain('Z-60');
    expect(problem.detail).toContain(CONSULTANT_NAME);

    // And the picker can see it coming, rather than learning from the refusal.
    const locks = await world.request('GET', `${base}/audits/${secondAuditId}/zone-locks`, {
      token: leaderToken,
    });
    expect(locks.status).toBe(200);
    const body = locks.body as ZoneLocksResponse;
    const lock = body.locks.find((candidate) => candidate.zoneId === zoneId);
    expect(lock).toBeDefined();
    expect(lock!.zoneCode).toBe('Z-60');
    expect(lock!.auditorName).toBe(CONSULTANT_NAME);
  });

  it('does not report the audit’s own Zones as locked', async () => {
    const zoneId = await createZone('Z-61', 'My own zone');
    const { auditId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: (await assign(world.actors.CONSULTANT.userId)).id,
    });

    const locks = await world.request('GET', `${base}/audits/${auditId}/zone-locks`, {
      token: consultantToken,
    });
    expect(locks.status).toBe(200);
    expect((locks.body as ZoneLocksResponse).locks.map((lock) => lock.zoneId)).not.toContain(
      zoneId,
    );
  });

  it('releases the Zone when the audit holding it is cancelled', async () => {
    const zoneId = await createZone('Z-62', 'Released zone');
    const { auditId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: (await assign(world.actors.CONSULTANT.userId)).id,
    });

    const secondAuditId = randomUUID();
    await world.request('POST', `${base}/audits`, {
      token: leaderToken,
      body: {
        id: secondAuditId,
        auditType: 'CROSS_5S',
        unitId: world.unitA,
        checklistVersionId: versionId,
        deviceId: LEADER_DEVICE,
      },
    });
    await captureEvidence(world, {
      token: leaderToken,
      evidenceId: randomUUID(),
      auditId: secondAuditId,
      kind: 'AUDITOR_SELFIE',
      deviceId: LEADER_DEVICE,
    });
    await world.request('POST', `${base}/audits/${secondAuditId}/start`, {
      token: leaderToken,
      body: { deviceId: LEADER_DEVICE },
    });

    const cancelled = await world.request('POST', `${base}/audits/${auditId}/cancel`, {
      token: asSuperAdmin(),
      body: { reason: 'The auditor was called away' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    // A-1 keeps every row of the cancelled audit; what it does not keep is the claim.
    const retaken = await world.request(
      'PUT',
      `${base}/audits/${secondAuditId}/zones/${randomUUID()}`,
      {
        token: leaderToken,
        body: { zoneId, sequenceNo: 1, checklistVersionId: versionId },
      },
    );
    expect(retaken.status, JSON.stringify(retaken.body)).toBe(200);
  });
});

describe('the post-completion override (A-2)', () => {
  it('changes an answer, rescores, and writes the audit-log entry with before and after', async () => {
    const { auditId, auditZoneId, expectedPercentage } = await completedAudit('Z-49', 'Override zone');

    const detail = await world.request('GET', `${base}/audits/${auditId}`, {
      token: asSuperAdmin(),
    });
    const first = (detail.body as AuditDetail).zones
      .find((zone) => zone.id === auditZoneId)!
      .responses.find((response) => response.globalOrder === 1)!;
    expect(first.value).toBe('SCORE_0');

    const overridden = await world.request(
      'PATCH',
      `${base}/audits/${auditId}/post-completion`,
      {
        token: asSuperAdmin(),
        body: {
          justification: 'Auditor confirmed by phone that Q1 was scored in error',
          changes: {
            responses: [{ responseId: first.id, value: 'SCORE_2', remark: 'Corrected on review' }],
          },
        },
      },
    );
    expect(overridden.status, JSON.stringify(overridden.body)).toBe(200);

    const zone = (overridden.body as AuditDetail).zones.find((z) => z.id === auditZoneId)!;
    const corrected = zone.responses.find((response) => response.id === first.id)!;
    expect(corrected.value).toBe('SCORE_2');
    expect(corrected.numericScore).toBe(2);
    // Two marks more over the same denominator: the score moved, and it was recomputed.
    expect(zone.totals.scorePercentage).not.toBe(expectedPercentage);

    const logged = await world.request(
      'GET',
      `${base}/audit-logs?action=audit.changed_after_completion&resourceId=${auditId}`,
      { token: asSuperAdmin() },
    );
    const entries = (logged.body as Page<{ before: unknown; after: unknown }>).data;
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]!.before)).toContain('SCORE_0');
    expect(JSON.stringify(entries[0]!.after)).toContain('Auditor confirmed by phone');
  });

  it('refuses the override on an audit that is not completed', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-50', 'Running zone');
    const { auditId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const response = await world.request('PATCH', `${base}/audits/${auditId}/post-completion`, {
      token: asSuperAdmin(),
      body: {
        justification: 'Trying to use the wrong door for an ordinary edit',
        changes: { zoneRemark: { auditZoneId: randomUUID(), remark: 'x' } },
      },
    });
    expect(response.status).toBe(409);
  });

  /**
   * R-30. The product owner settled that an auditor may correct an audit they conducted,
   * and this is the whole of what that means: the same door, the same justification, the
   * same audit-log entry — with the Consultant's own name on it.
   */
  it('lets the auditor correct their own completed audit, with the reason logged', async () => {
    const { auditId, auditZoneId, expectedPercentage } = await completedAudit('Z-51', 'Own correction');

    const detail = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    const zone = (detail.body as AuditDetail).zones.find((z) => z.id === auditZoneId)!;
    const wrong = zone.responses.find((response) => response.value === 'SCORE_0')!;

    const corrected = await world.request('PATCH', `${base}/audits/${auditId}/post-completion`, {
      token: consultantToken,
      body: {
        justification: 'I marked the rack unlabelled; the label was on the far side.',
        changes: { responses: [{ responseId: wrong.id, value: 'SCORE_2' }] },
      },
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);

    // The stored score moved, which is the half the trigger had to be widened for: the
    // recompute runs inside the carve-out, on rows A-2 has frozen.
    const after = (corrected.body as AuditDetail).zones.find((z) => z.id === auditZoneId)!;
    expect(after.totals.scorePercentage).not.toBe(expectedPercentage);
    expect(after.responses.find((response) => response.id === wrong.id)!.value).toBe('SCORE_2');

    // And it is on the record, under the Consultant's own name.
    const logged = await world.request(
      'GET',
      `${base}/audit-logs?action=audit.changed_after_completion&resourceId=${auditId}`,
      { token: asSuperAdmin() },
    );
    const entries = (logged.body as Page<{ actorUserId: string; before: unknown; after: unknown }>)
      .data;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actorUserId).toBe(world.actors.CONSULTANT.userId);
    expect(JSON.stringify(entries[0]!.before)).toContain('SCORE_0');
    expect(JSON.stringify(entries[0]!.after)).toContain('the far side');
  });

  /**
   * R-31: a corrected mark does not stop at the response row.
   *
   * The case the product owner asked for, both ways round in one audit — a finding that
   * goes away and a finding that appears — because the cascade has to do both or it has
   * only moved the problem.
   */
  it('withdraws a finding the correction removed and raises one it created', async () => {
    const assignment = await assign(world.actors.CONSULTANT.userId);
    const zoneId = await createZone('Z-66', 'Cascade zone');
    const { auditId, auditZoneId } = await startAuditWithZone({
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      zoneId,
      assignmentId: assignment.id,
    });

    const values = fiftyAnswers();
    // The pattern the suite uses everywhere: Q1 is a 0, Q2 is a 2. One of each is the
    // whole point of this test.
    expect(values[0]).toBe('SCORE_0');
    expect(values[1]).toBe('SCORE_2');
    await answer(consultantToken, auditZoneId, values);

    const answered = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    const responses = (answered.body as AuditDetail).zones.find((z) => z.id === auditZoneId)!
      .responses;
    const wrongZero = responses.find((response) => response.globalOrder === 1)!;
    const wrongTwo = responses.find((response) => response.globalOrder === 2)!;

    // A photograph under each. The server classifies from the linked response (E-1), so
    // one is a nonconformity and one is not — no classification is sent from here.
    const zeroPhoto = await captureEvidence(world, {
      token: consultantToken,
      evidenceId: randomUUID(),
      auditId,
      auditZoneId,
      questionResponseId: wrongZero.id,
      kind: 'QUESTION_EVIDENCE',
      deviceId: CONSULTANT_DEVICE,
    });
    const twoPhoto = await captureEvidence(world, {
      token: consultantToken,
      evidenceId: randomUUID(),
      auditId,
      auditZoneId,
      questionResponseId: wrongTwo.id,
      kind: 'QUESTION_EVIDENCE',
      deviceId: CONSULTANT_DEVICE,
    });

    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token: consultantToken,
      body: {},
    });
    const completed = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect((completed.body as Audit).status).toBe('CORRECTIVE_ACTION_OPEN');

    const before = await listActions(auditId);
    expect(before).toHaveLength(1);
    expect(before[0]!.evidenceId).toBe(zeroPhoto.evidenceId);
    expect(before[0]!.status).toBe('OPEN');

    // The correction: the 0 was wrong, and so was the 2.
    const corrected = await world.request('PATCH', `${base}/audits/${auditId}/post-completion`, {
      token: consultantToken,
      body: {
        justification: 'Q1 was labelled after all; Q2’s guard was missing and I marked it 2.',
        changes: {
          responses: [
            { responseId: wrongZero.id, value: 'SCORE_2' },
            { responseId: wrongTwo.id, value: 'SCORE_0' },
          ],
        },
      },
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);

    const after = await listActions(auditId);
    expect(after).toHaveLength(2);

    // The finding that went: withdrawn, not verified. Nobody fixed anything.
    const gone = after.find((action) => action.evidenceId === zeroPhoto.evidenceId)!;
    expect(gone.status).toBe('WITHDRAWN');
    expect(gone.resolvedAt).not.toBeNull();

    // The finding that appeared: a real, answerable action with a due date in the future.
    const raised = after.find((action) => action.evidenceId === twoPhoto.evidenceId)!;
    expect(raised.status).toBe('OPEN');
    expect(raised.questionGlobalOrder).toBe(2);
    expect(Date.parse(raised.dueAt!)).toBeGreaterThan(Date.now());

    // One settled of two, so §2.8 puts the audit between open and closed.
    expect((corrected.body as AuditDetail).status).toBe('PARTIALLY_CLOSED');

    // E-2, after completion as well as before it: the photographs were refiled, which is
    // what keeps them out of the wrong section of the report.
    const photos = await world.request('GET', `${base}/audits/${auditId}/evidence`, {
      token: consultantToken,
    });
    const byId = new Map(
      (photos.body as Page<{ id: string; classification: string }>).data.map((row) => [
        row.id,
        row.classification,
      ]),
    );
    expect(byId.get(zeroPhoto.evidenceId)).toBe('GOOD');
    expect(byId.get(twoPhoto.evidenceId)).toBe('NONCONFORMITY');
  });

  it('refuses a Consultant an audit somebody else conducted', async () => {
    // The Zone Leader's own CROSS_5S in the same Unit. `own_audits` is what keeps the two
    // apart, and AZ-3 makes the refusal a 404 rather than a 403 — being told "forbidden"
    // would confirm the audit exists.
    const zoneId = await createZone('Z-64', 'Somebody else’s zone');
    const leaderAuditId = randomUUID();
    await world.request('POST', `${base}/audits`, {
      token: leaderToken,
      body: {
        id: leaderAuditId,
        auditType: 'CROSS_5S',
        unitId: world.unitA,
        checklistVersionId: versionId,
        deviceId: LEADER_DEVICE,
      },
    });
    await captureEvidence(world, {
      token: leaderToken,
      evidenceId: randomUUID(),
      auditId: leaderAuditId,
      kind: 'AUDITOR_SELFIE',
      deviceId: LEADER_DEVICE,
    });
    await world.request('POST', `${base}/audits/${leaderAuditId}/start`, {
      token: leaderToken,
      body: { deviceId: LEADER_DEVICE },
    });
    const leaderZoneId = randomUUID();
    await world.request('PUT', `${base}/audits/${leaderAuditId}/zones/${leaderZoneId}`, {
      token: leaderToken,
      body: { zoneId, sequenceNo: 1, checklistVersionId: versionId },
    });
    await answer(leaderToken, leaderZoneId, fiftyAnswers());
    await world.request('POST', `${base}/audits/${leaderAuditId}/zones/${leaderZoneId}/complete`, {
      token: leaderToken,
      body: {},
    });
    await world.request('POST', `${base}/audits/${leaderAuditId}/complete`, {
      token: leaderToken,
      body: {},
    });

    const response = await world.request(
      'PATCH',
      `${base}/audits/${leaderAuditId}/post-completion`,
      {
        token: consultantToken,
        body: {
          justification: 'Correcting a colleague’s audit, which is not mine to correct',
          changes: { zoneRemark: { auditZoneId: leaderZoneId, remark: 'x' } },
        },
      },
    );
    expect(response.status).toBe(404);
  });

  it('is closed to a Coordinator and a Zone Leader', async () => {
    const { auditId } = await completedAudit('Z-65', 'Not theirs to change');
    for (const role of ['COORDINATOR', 'ZONE_LEADER'] as const) {
      const response = await world.request('PATCH', `${base}/audits/${auditId}/post-completion`, {
        token: world.actors[role].accessToken,
        body: {
          justification: 'A role that holds no grant for this at all',
          changes: { zoneRemark: { auditZoneId: randomUUID(), remark: 'x' } },
        },
      });
      expect(response.status, `${role}: ${JSON.stringify(response.body)}`).toBe(403);
    }
  });
});

/** This audit's corrective actions, in open order, as the Super Admin sees them. */
async function listActions(auditId: string): Promise<CorrectiveAction[]> {
  const response = await world.request(
    'GET',
    `${base}/corrective-actions?auditId=${auditId}&limit=100`,
    { token: asSuperAdmin() },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body as Page<CorrectiveAction>).data;
}

/** A completed one-Zone audit, answered with the fifty-value pattern. */
async function completedAudit(code: string, name: string) {
  const zoneId = await createZone(code, name);
  return completedAuditForZone(zoneId);
}

async function completedAuditForZone(zoneId: string) {
  const assignment = await assign(world.actors.CONSULTANT.userId);
  const { auditId, auditZoneId } = await startAuditWithZone({
    token: consultantToken,
    deviceId: CONSULTANT_DEVICE,
    zoneId,
    assignmentId: assignment.id,
  });

  const values = fiftyAnswers();
  await answer(consultantToken, auditZoneId, values);

  await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
    token: consultantToken,
    body: {},
  });
  await world.request('POST', `${base}/audits/${auditId}/complete`, {
    token: consultantToken,
    body: {},
  });

  const expected = scoreZone(
    values.map((value, index) => ({ section: S_SECTION_ORDER[Math.floor(index / 10)]!, value })),
  );

  return { auditId, auditZoneId, expectedPercentage: expected.totals.scorePercentage };
}
