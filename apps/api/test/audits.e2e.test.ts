import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  API_BASE_PATH,
  type Audit,
  type AuditAssignment,
  type AuditDetail,
  type AuditScoreSummary,
  type AuditZone,
  type Page,
  type ResponseValue,
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

  it('adopts a device the session is bound to but nobody ever registered', async () => {
    // `deviceId` and `platform` are independently optional on login, and the device is only
    // upserted when *both* arrive — while the token is bound to `deviceId` regardless. A
    // client that sends the id without the platform therefore holds a session naming a
    // device the server has no row for, and every audit it starts used to be refused for
    // it. `requireDevice` makes the token's id the only one usable, so this is the shape
    // that reaches `claimDevice` with nothing registered behind it.
    const unregistered = randomUUID();
    resetLimits();
    const login = await world.request('POST', `${base}/auth/login`, {
      body: {
        loginId: world.actors.CONSULTANT.loginId,
        password: FIXTURE_PASSWORD,
        deviceId: unregistered,
      },
    });
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    const before = await world.owner.query(`SELECT 1 FROM device WHERE id = $1`, [unregistered]);
    expect(before.rows).toHaveLength(0);

    const response = await world.request('POST', `${base}/audits`, {
      token: (login.body as { accessToken: string }).accessToken,
      body: {
        id: randomUUID(),
        auditType: 'EXTERNAL_5S',
        unitId: world.unitA,
        deviceId: unregistered,
      },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect((response.body as Audit).owningDeviceId).toBe(unregistered);

    const { rows } = await world.owner.query(
      `SELECT user_id, revoked_at FROM device WHERE id = $1`,
      [unregistered],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(world.actors.CONSULTANT.userId);
    expect(rows[0].revoked_at).toBeNull();
  });

  it('refuses the previous holder of a handset once somebody else signs in on it', async () => {
    // The handover is allowed at login, and this is its other half: the session the
    // previous holder still carries names a device that is no longer theirs. `adopt` is
    // `onConflictDoNothing`, so it cannot take the row back, and the refusal stands —
    // naming the cause rather than the old, shared "Unknown device".
    const handset = randomUUID();
    resetLimits();
    const staleToken = await loginFromDevice(world, world.actors.CONSULTANT, handset);
    resetLimits();
    await loginFromDevice(world, world.actors.ZONE_LEADER, handset);

    const response = await world.request('POST', `${base}/audits`, {
      token: staleToken,
      body: {
        id: randomUUID(),
        auditType: 'EXTERNAL_5S',
        unitId: world.unitA,
        deviceId: handset,
      },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/another user|revoked/i);

    const { rows } = await world.owner.query(`SELECT user_id FROM device WHERE id = $1`, [handset]);
    expect(rows[0].user_id).toBe(world.actors.ZONE_LEADER.userId);
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

  it('is closed to everyone but a Super Admin', async () => {
    const { auditId } = await completedAudit('Z-51', 'Closed override');
    const response = await world.request('PATCH', `${base}/audits/${auditId}/post-completion`, {
      token: consultantToken,
      body: {
        justification: 'The auditor would like to change their own answer',
        changes: { zoneRemark: { auditZoneId: randomUUID(), remark: 'x' } },
      },
    });
    expect(response.status).toBe(403);
  });
});

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
