import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  type Audit,
  type AuditDetail,
  type AuditScoreSummary,
  type AuditZone,
  type Evidence,
  type EvidenceViewUrl,
  type Page,
} from '@audit5s/contracts';
import { S_SECTION_ORDER } from '@audit5s/domain';
import {
  captureEvidence,
  loginFromDevice,
  startWorld,
  stopWorld,
  type TestWorld,
} from './harness';

/**
 * The walk-by audit (§2.7), end to end through the real endpoints.
 *
 * §2.7 opens with four words — "No questionnaire, no score" — and most of this file is
 * about the second half. A walk-by that quietly acquired a score would not fail: it would
 * produce all-zero section rows and a `null` percentage, indistinguishable from a scored
 * audit nobody has answered, and PART 11's "walk-by audits are excluded from every score
 * metric" would then have to be implemented by every query remembering to filter rows
 * that should never have existed.
 *
 * The rest is the flow's own two departures from a scored audit: steps 3 and 4 let the
 * auditor describe the Zone and name its leader, which is the one place a client supplies
 * a D6 snapshot — and it is a place §2.7 asks for by name, because a walk-by *is* an
 * observation rather than a questionnaire.
 */

let world: TestWorld;
const base = API_BASE_PATH;

const DEVICE_ID = '01930000-0000-7000-8000-0000000ab001';

let consultantToken: string;
let versionId: string;
const questionIds: string[] = [];

beforeAll(async () => {
  world = await startWorld();
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, DEVICE_ID);
  await seedChecklist();
  // The Zone Leader of Unit A leads every Zone this suite creates, so §2.7 step 4 has
  // somebody to confirm and D6 has a name to snapshot.
}, 180_000);

afterAll(async () => {
  await stopWorld(world);
});

async function seedChecklist(): Promise<void> {
  const { rows: template } = await world.owner.query(
    `INSERT INTO checklist_template (code, name) VALUES ('SHOP_FLOOR', 'Shop Floor') RETURNING id`,
  );
  const { rows: version } = await world.owner.query(
    `INSERT INTO checklist_version (template_id, version_number, total_questions, content_hash)
     VALUES ($1, 1, 50, 'walk-by-v1') RETURNING id`,
    [template[0].id],
  );
  versionId = version[0].id as string;

  for (const [sectionIndex, section] of S_SECTION_ORDER.entries()) {
    for (let order = 1; order <= 10; order += 1) {
      const globalOrder = sectionIndex * 10 + order;
      const { rows } = await world.owner.query(
        `INSERT INTO checklist_question (version_id, section, order_in_section, global_order,
                                         text, allows_na)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [versionId, section, order, globalOrder, `Question ${globalOrder}`],
      );
      questionIds.push(rows[0].id as string);
    }
  }

  await world.owner.query(
    `UPDATE checklist_version SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [versionId],
  );
}

let zoneCounter = 60;

/** A Zone of Unit A, led by Unit A's Zone Leader. */
async function makeZone(description: string | null = null): Promise<string> {
  zoneCounter += 1;
  const { rows } = await world.owner.query(
    `INSERT INTO zone (unit_id, code, name, description, zone_leader_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      world.unitA,
      `Z-${zoneCounter}`,
      `Walk-by zone ${zoneCounter}`,
      description,
      world.actors.ZONE_LEADER.userId,
    ],
  );
  return rows[0].id as string;
}

/** §2.7 steps 1–2: the selfie, then an IN_PROGRESS walk-by with no Zones yet. */
async function startWalkBy(): Promise<string> {
  const auditId = randomUUID();

  const created = await world.request('POST', `${base}/audits`, {
    token: consultantToken,
    body: { id: auditId, auditType: 'WALK_BY', unitId: world.unitA, deviceId: DEVICE_ID },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  // §2.7 step 1 is mandatory and has not happened yet, so §7.1 holds it at ASSIGNED.
  expect((created.body as Audit).status).toBe('ASSIGNED');
  expect((created.body as Audit).scored).toBe(false);

  await captureEvidence(world, {
    token: consultantToken,
    evidenceId: randomUUID(),
    auditId,
    kind: 'AUDITOR_SELFIE',
    deviceId: DEVICE_ID,
  });

  const started = await world.request('POST', `${base}/audits/${auditId}/start`, {
    token: consultantToken,
    body: { deviceId: DEVICE_ID },
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  return auditId;
}

/** §2.7 steps 2–4: add a Zone, with an optional description and leader. */
async function addZone(
  auditId: string,
  zoneId: string,
  sequenceNo: number,
  extra: Record<string, unknown> = {},
): Promise<{ auditZoneId: string; body: AuditZone; status: number }> {
  const auditZoneId = randomUUID();
  const response = await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
    token: consultantToken,
    body: { zoneId, sequenceNo, ...extra },
  });
  return { auditZoneId, body: response.body as AuditZone, status: response.status };
}

/** §2.7 steps 5–7: one live photograph in the Zone. */
async function photograph(
  auditId: string,
  auditZoneId: string,
  classification: 'GOOD' | 'NONCONFORMITY' | 'NEUTRAL' = 'NONCONFORMITY',
): Promise<string> {
  const evidenceId = randomUUID();
  await captureEvidence(world, {
    token: consultantToken,
    evidenceId,
    auditId,
    auditZoneId,
    kind: 'WALK_BY_PHOTO',
    classification,
    deviceId: DEVICE_ID,
  });
  return evidenceId;
}

// ---------------------------------------------------------------------------------------

describe('§2.7 — the ten steps, in order', () => {
  it('runs selfie → zone → description → leader → photo → remarks → save → finish', async () => {
    const auditId = await startWalkBy();
    const zoneId = await makeZone('The Zone’s own description, from master data');

    // Steps 3 and 4: the auditor describes what they are looking at and confirms the
    // leader they are standing with. Both are snapshotted (D6).
    const { auditZoneId, body: zone, status } = await addZone(auditId, zoneId, 1, {
      zoneDescription: 'Press line, north bay — pallets stacked against the panel',
      zoneLeaderUserId: world.actors.ZONE_LEADER.userId,
    });
    expect(status, JSON.stringify(zone)).toBe(200);
    expect(zone.zoneDescriptionSnapshot).toBe(
      'Press line, north bay — pallets stacked against the panel',
    );
    expect(zone.zoneLeaderUserIdSnapshot).toBe(world.actors.ZONE_LEADER.userId);
    // The *name*, not just the id — D6 snapshots it "so it survives even a user rename",
    // and before 0008's definer function this was silently null for a Consultant.
    expect(zone.zoneLeaderNameSnapshot).toBe('Zoe Leader');
    // No questionnaire: nothing was pinned, so there is nothing to answer.
    expect(zone.checklistVersionId).toBeNull();

    // Steps 5–8: photographs, one of them remarked.
    const first = await photograph(auditId, auditZoneId, 'NONCONFORMITY');
    const second = await photograph(auditId, auditZoneId, 'GOOD');

    const remarked = await world.request('PATCH', `${base}/evidence/${first}`, {
      token: consultantToken,
      body: { remark: 'Third pallet blocking the isolation switch' },
    });
    expect(remarked.status).toBe(200);

    // Step 9: save the Zone, with its own remark.
    const finished = await world.request(
      'POST',
      `${base}/audits/${auditId}/zones/${auditZoneId}/complete`,
      { token: consultantToken, body: { zoneRemark: 'Housekeeping slipping on the night shift' } },
    );
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect((finished.body as AuditZone).status).toBe('COMPLETED');
    expect((finished.body as AuditZone).zoneRemark).toBe(
      'Housekeeping slipping on the night shift',
    );

    // Step 10: finish the audit.
    const completed = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    // Its nonconformity photograph opened a corrective action (§7.1).
    expect((completed.body as Audit).status).toBe('CORRECTIVE_ACTION_OPEN');

    // Both photographs are on the record, with the auditor's own classifications.
    const gallery = await world.request('GET', `${base}/audits/${auditId}/evidence`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    const photos = (gallery.body as Page<Evidence>).data.filter(
      (item) => item.kind === 'WALK_BY_PHOTO',
    );
    expect(photos).toHaveLength(2);
    expect(photos.map((item) => item.classification).sort()).toEqual(['GOOD', 'NONCONFORMITY']);
    expect(photos.find((item) => item.id === first)!.remark).toBe(
      'Third pallet blocking the isolation switch',
    );
    expect(photos.find((item) => item.id === second)!.classification).toBe('GOOD');
  });

  it('defaults the description to the Zone’s own when the auditor says nothing', async () => {
    // §2.7 step 3: "Optional; defaults to the Zone's current description, snapshotted
    // either way."
    const auditId = await startWalkBy();
    const zoneId = await makeZone('Boiler house, behind the utility block');

    const { body: zone } = await addZone(auditId, zoneId, 1);
    expect(zone.zoneDescriptionSnapshot).toBe('Boiler house, behind the utility block');
    // And the leader too: saying nothing is the "confirmed" case.
    expect(zone.zoneLeaderNameSnapshot).toBe('Zoe Leader');
  });

  it('refuses a Zone Leader from another Unit', async () => {
    // C2: the leader pointer grants nothing, so the membership is the check. A leader of
    // another Unit would put a name on a report for a plant they do not work in.
    const auditId = await startWalkBy();
    const zoneId = await makeZone();

    const { status, body } = await addZone(auditId, zoneId, 1, {
      zoneLeaderUserId: world.outOfScopeUserId,
    });
    expect(status, JSON.stringify(body)).toBe(422);
    expect((body as unknown as { errors: Array<{ field: string }> }).errors[0]!.field).toBe(
      'zoneLeaderUserId',
    );
  });

  it('does not let the snapshots move on a later write (D6)', async () => {
    // The exception §2.7 carves out is for the *first* write, like every other snapshot.
    // A second upsert must not be able to rewrite what the report will render.
    const auditId = await startWalkBy();
    const zoneId = await makeZone('Original');

    const { auditZoneId } = await addZone(auditId, zoneId, 1, {
      zoneDescription: 'What the auditor saw on the day',
    });

    const again = await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
      token: consultantToken,
      body: { zoneId, sequenceNo: 1, zoneDescription: 'Rewritten a week later' },
    });
    expect(again.status).toBe(200);
    expect((again.body as AuditZone).zoneDescriptionSnapshot).toBe(
      'What the auditor saw on the day',
    );
  });
});

describe('R-19 — the auditor names the Zone by number', () => {
  it('adds a Zone the Unit has never used, and snapshots what the auditor typed', async () => {
    const auditId = await startWalkBy();

    const response = await world.request('PUT', `${base}/audits/${auditId}/zones/${randomUUID()}`, {
      token: consultantToken,
      body: {
        zoneNumber: 88,
        sequenceNo: 1,
        zoneDescription: 'Scrap yard behind the press shop',
        zoneLeaderName: 'Ravi Kumar',
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const zone = response.body as AuditZone;
    expect(zone).toMatchObject({
      zoneCodeSnapshot: 'Z-88',
      zoneNameSnapshot: 'Zone 88',
      zoneDescriptionSnapshot: 'Scrap yard behind the press shop',
      zoneLeaderNameSnapshot: 'Ravi Kumar',
      // A typed name is not an account (C2).
      zoneLeaderUserIdSnapshot: null,
    });

    // It is master data now — one row, logged like a Coordinator's — and the next audit
    // naming Zone 88 reuses it, so the Zone's score history accumulates.
    const { rows } = await world.owner.query(
      `SELECT id, name, description FROM zone WHERE unit_id = $1 AND code = 'Z-88'`,
      [world.unitA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(zone.zoneId);
    expect(rows[0].description).toBe('Scrap yard behind the press shop');

    const { rows: logged } = await world.owner.query(
      `SELECT actor_user_id FROM audit_log WHERE action = 'zone.created' AND resource_id = $1`,
      [zone.zoneId],
    );
    expect(logged).toEqual([{ actor_user_id: world.actors.CONSULTANT.userId }]);

    const secondAuditId = await startWalkBy();
    const again = await world.request(
      'PUT',
      `${base}/audits/${secondAuditId}/zones/${randomUUID()}`,
      { token: consultantToken, body: { zoneNumber: 88, sequenceNo: 1 } },
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((again.body as AuditZone).zoneId).toBe(zone.zoneId);
    // Nothing typed this time, so the Zone's own description is what is snapshotted.
    expect((again.body as AuditZone).zoneDescriptionSnapshot).toBe(
      'Scrap yard behind the press shop',
    );
  });

  it('refuses a Zone that names neither a number nor an id', async () => {
    const auditId = await startWalkBy();

    const response = await world.request('PUT', `${base}/audits/${auditId}/zones/${randomUUID()}`, {
      token: consultantToken,
      body: { sequenceNo: 1 },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
  });
});

describe('§2.7 — no questionnaire', () => {
  it('refuses a walk-by audit that pins a checklist version', async () => {
    const refused = await world.request('POST', `${base}/audits`, {
      token: consultantToken,
      body: {
        id: randomUUID(),
        auditType: 'WALK_BY',
        unitId: world.unitA,
        checklistVersionId: versionId,
        deviceId: DEVICE_ID,
      },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(
      (refused.body as { errors: Array<{ field: string }> }).errors[0]!.field,
    ).toBe('checklistVersionId');
  });

  it('refuses a walk-by Zone that pins one', async () => {
    const auditId = await startWalkBy();
    const zoneId = await makeZone();

    const { status, body } = await addZone(auditId, zoneId, 1, { checklistVersionId: versionId });
    expect(status, JSON.stringify(body)).toBe(422);
  });

  it('refuses an answer on a walk-by Zone, at the service and in the database', async () => {
    const auditId = await startWalkBy();
    const zoneId = await makeZone();
    const { auditZoneId } = await addZone(auditId, zoneId, 1);

    const answered = await world.request(
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
    expect(answered.status, JSON.stringify(answered.body)).toBe(422);

    // …and the same statement, issued as the schema owner with no service in the way.
    // QR-2 is a guarantee, not a convention (0008).
    await expect(
      world.owner.query(
        `INSERT INTO question_response (id, audit_zone_id, audit_id, checklist_question_id,
                                        section, global_order, value, numeric_score, answered_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'S1_SORT', 1, 'SCORE_2', 2, now())`,
        [auditZoneId, auditId, questionIds[0]],
      ),
    ).rejects.toThrow(/no checklist version pinned/);
  });
});

describe('§2.7, PART 11 — no score', () => {
  it('reports scored: false and writes no section-score rows', async () => {
    const auditId = await startWalkBy();
    const zoneId = await makeZone();
    const { auditZoneId } = await addZone(auditId, zoneId, 1);
    await photograph(auditId, auditZoneId);

    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token: consultantToken,
      body: {},
    });
    await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });

    // `GET /audits/{id}`: the flag says plainly what all-zero totals cannot.
    const detail = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    const audit = detail.body as AuditDetail;
    expect(audit.scored).toBe(false);
    expect(audit.totals.scorePercentage).toBeNull();
    expect(audit.totals.applicableQuestions).toBe(0);

    // `GET /audits/{id}/summary`: the same, and every Zone with it.
    const summary = await world.request('GET', `${base}/audits/${auditId}/summary`, {
      token: consultantToken,
    });
    const scores = summary.body as AuditScoreSummary;
    expect(scores.scored).toBe(false);
    expect(scores.audit.totals.scorePercentage).toBeNull();
    for (const zone of scores.zones) {
      expect(zone.totals.scorePercentage).toBeNull();
      // Still all five sections, so a renderer never has to fill gaps — each one null.
      expect(zone.sections).toHaveLength(5);
      expect(zone.sections.every((section) => section.pct === null)).toBe(true);
    }

    // **This** is what Phase 8 relies on: there are no rows to exclude, because none were
    // written. A materialised all-zero section score would be a score that does not exist.
    const { rows } = await world.owner.query(
      `SELECT COUNT(*)::int AS count
         FROM audit_zone_section_score s
         JOIN audit_zone z ON z.id = s.audit_zone_id
        WHERE z.audit_id = $1`,
      [auditId],
    );
    expect(rows[0].count).toBe(0);

    // And the audit's own cached totals were left alone rather than set to zero-of-zero.
    const { rows: cached } = await world.owner.query(
      `SELECT total_score, raw_score, max_score FROM audit WHERE id = $1`,
      [auditId],
    );
    expect(cached[0].total_score).toBeNull();
  });

  it('still writes them for a scored audit in the same database', async () => {
    // The exclusion has to be the audit type and not a bug that stopped writing scores.
    const zoneId = await makeZone();
    const auditId = randomUUID();

    await world.request('POST', `${base}/audit-assignments`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        unitId: world.unitA,
        auditorUserId: world.actors.CONSULTANT.userId,
        auditType: 'EXTERNAL_5S',
      },
    });
    await world.request('POST', `${base}/audits`, {
      token: consultantToken,
      body: {
        id: auditId,
        auditType: 'EXTERNAL_5S',
        unitId: world.unitA,
        checklistVersionId: versionId,
        deviceId: DEVICE_ID,
      },
    });
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId: randomUUID(),
      auditId,
      kind: 'AUDITOR_SELFIE',
      deviceId: DEVICE_ID,
    });
    await world.request('POST', `${base}/audits/${auditId}/start`, {
      token: consultantToken,
      body: { deviceId: DEVICE_ID },
    });

    const auditZoneId = randomUUID();
    await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
      token: consultantToken,
      body: { zoneId, sequenceNo: 1, checklistVersionId: versionId },
    });

    for (const [index, questionId] of questionIds.entries()) {
      await world.request(
        'PUT',
        `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`,
        {
          token: consultantToken,
          body: {
            checklistQuestionId: questionId,
            value: index % 5 === 0 ? 'SCORE_0' : 'SCORE_2',
            answeredAt: new Date().toISOString(),
          },
        },
      );
    }

    const finished = await world.request(
      'POST',
      `${base}/audits/${auditId}/zones/${auditZoneId}/complete`,
      { token: consultantToken, body: {} },
    );
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);

    const { rows } = await world.owner.query(
      `SELECT COUNT(*)::int AS count FROM audit_zone_section_score WHERE audit_zone_id = $1`,
      [auditZoneId],
    );
    expect(rows[0].count).toBe(5);

    const detail = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    expect((detail.body as Audit).scored).toBe(true);
    expect((detail.body as Audit).totals.scorePercentage).not.toBeNull();
  });
});

describe('§7.1 — every walk-by Zone needs a photograph, at the audit level too', () => {
  it('refuses to complete a walk-by whose Zone lost its only photograph', async () => {
    // The gap the audit-level guard closes, and it needs no misuse to reach: finish a Zone
    // with its one photograph, then delete that photograph. E-4 permits the delete —
    // the *audit* is still IN_PROGRESS — and the Zone stays COMPLETED.
    const auditId = await startWalkBy();
    const zoneId = await makeZone();
    const { auditZoneId } = await addZone(auditId, zoneId, 1);
    const evidenceId = await photograph(auditId, auditZoneId);

    const finished = await world.request(
      'POST',
      `${base}/audits/${auditId}/zones/${auditZoneId}/complete`,
      { token: consultantToken, body: {} },
    );
    expect(finished.status).toBe(200);

    const deleted = await world.request('DELETE', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
    });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect((deleted.body as Evidence).deletedAt).not.toBeNull();

    const refused = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const problem = refused.body as { code: string; detail: string };
    expect(problem.code).toBe('EVIDENCE_REQUIRED');
    // Named, so the auditor knows which Zone to walk back to.
    expect(problem.detail).toContain(`Z-${zoneCounter}`);

    // Photograph it again and the audit completes.
    await photograph(auditId, auditZoneId);
    const completed = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  });

  it('does not impose the rule on a scored audit', async () => {
    // §7.2's two guards are alternatives, not a conjunction: a fifty-question Zone was
    // never asked for a photograph.
    const zoneId = await makeZone();
    const auditId = randomUUID();

    await world.request('POST', `${base}/audit-assignments`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        unitId: world.unitA,
        auditorUserId: world.actors.CONSULTANT.userId,
        auditType: 'EXTERNAL_5S',
      },
    });
    await world.request('POST', `${base}/audits`, {
      token: consultantToken,
      body: {
        id: auditId,
        auditType: 'EXTERNAL_5S',
        unitId: world.unitA,
        checklistVersionId: versionId,
        deviceId: DEVICE_ID,
      },
    });
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId: randomUUID(),
      auditId,
      kind: 'AUDITOR_SELFIE',
      deviceId: DEVICE_ID,
    });
    await world.request('POST', `${base}/audits/${auditId}/start`, {
      token: consultantToken,
      body: { deviceId: DEVICE_ID },
    });

    const auditZoneId = randomUUID();
    await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
      token: consultantToken,
      body: { zoneId, sequenceNo: 1, checklistVersionId: versionId },
    });
    for (const questionId of questionIds) {
      await world.request('PUT', `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`, {
        token: consultantToken,
        body: {
          checklistQuestionId: questionId,
          value: 'SCORE_2',
          answeredAt: new Date().toISOString(),
        },
      });
    }
    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token: consultantToken,
      body: {},
    });

    // No photograph anywhere but the selfie, and it completes.
    const completed = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  });
});

describe('the auditor’s classification, changed after the fact (§2.7)', () => {
  it('lets a walk-by photograph be re-judged before completion', async () => {
    // An auditor who takes ten photographs and then reviews them is doing the job in the
    // order the job happens. `upload-intent` cannot carry the second answer: §8.7 makes it
    // idempotent on the id and it returns the existing intent untouched.
    const auditId = await startWalkBy();
    const zoneId = await makeZone();
    const { auditZoneId } = await addZone(auditId, zoneId, 1);
    const evidenceId = await photograph(auditId, auditZoneId, 'NEUTRAL');

    const rejudged = await world.request('PATCH', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
      body: { classification: 'NONCONFORMITY', remark: 'On reflection: a finding' },
    });
    expect(rejudged.status, JSON.stringify(rejudged.body)).toBe(200);
    expect((rejudged.body as Evidence).classification).toBe('NONCONFORMITY');
    expect((rejudged.body as Evidence).remark).toBe('On reflection: a finding');
  });

  it('takes the summary flag off a photograph re-judged to NEUTRAL (E-3)', async () => {
    // The CHECK constraint would refuse the whole statement — including the
    // reclassification the auditor actually asked for — so the flag comes off in the same
    // patch rather than the request failing for a reason they cannot act on.
    const auditId = await startWalkBy();
    const zoneId = await makeZone();
    const { auditZoneId } = await addZone(auditId, zoneId, 1);
    const evidenceId = await photograph(auditId, auditZoneId, 'GOOD');

    const flagged = await world.request('PATCH', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
      body: { isSummaryFlagged: true },
    });
    expect(flagged.status).toBe(200);
    expect((flagged.body as Evidence).isSummaryFlagged).toBe(true);

    const neutral = await world.request('PATCH', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
      body: { classification: 'NEUTRAL' },
    });
    expect(neutral.status, JSON.stringify(neutral.body)).toBe(200);
    expect((neutral.body as Evidence).classification).toBe('NEUTRAL');
    expect((neutral.body as Evidence).isSummaryFlagged).toBe(false);
  });

  it('refuses a classification on question evidence, where E-1 derives it', async () => {
    const zoneId = await makeZone();
    const auditId = randomUUID();

    await world.request('POST', `${base}/audit-assignments`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        unitId: world.unitA,
        auditorUserId: world.actors.CONSULTANT.userId,
        auditType: 'EXTERNAL_5S',
      },
    });
    await world.request('POST', `${base}/audits`, {
      token: consultantToken,
      body: {
        id: auditId,
        auditType: 'EXTERNAL_5S',
        unitId: world.unitA,
        checklistVersionId: versionId,
        deviceId: DEVICE_ID,
      },
    });
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId: randomUUID(),
      auditId,
      kind: 'AUDITOR_SELFIE',
      deviceId: DEVICE_ID,
    });
    await world.request('POST', `${base}/audits/${auditId}/start`, {
      token: consultantToken,
      body: { deviceId: DEVICE_ID },
    });

    const auditZoneId = randomUUID();
    await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
      token: consultantToken,
      body: { zoneId, sequenceNo: 1, checklistVersionId: versionId },
    });

    const responseId = randomUUID();
    await world.request('PUT', `${base}/audit-zones/${auditZoneId}/responses/${responseId}`, {
      token: consultantToken,
      body: {
        checklistQuestionId: questionIds[0],
        value: 'SCORE_2',
        answeredAt: new Date().toISOString(),
      },
    });

    const evidenceId = randomUUID();
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId,
      auditId,
      auditZoneId,
      kind: 'QUESTION_EVIDENCE',
      questionResponseId: responseId,
      deviceId: DEVICE_ID,
    });

    // Refused rather than ignored: unlike the field on an upload intent, nothing replays a
    // patch, so a classification here is a caller asserting what E-1 reserves.
    const refused = await world.request('PATCH', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
      body: { classification: 'NONCONFORMITY' },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect((refused.body as { detail: string }).detail).toContain('E-1');

    // The derived value is untouched.
    const unchanged = await world.request('GET', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
    });
    expect((unchanged.body as Evidence).classification).toBe('GOOD');
  });
});

describe('the audit-wide gallery (§8.7)', () => {
  it('lists every Zone’s photographs and filters them', async () => {
    const auditId = await startWalkBy();
    const firstZone = await addZone(auditId, await makeZone(), 1);
    const secondZone = await addZone(auditId, await makeZone(), 2);

    const good = await photograph(auditId, firstZone.auditZoneId, 'GOOD');
    const bad = await photograph(auditId, firstZone.auditZoneId, 'NONCONFORMITY');
    const other = await photograph(auditId, secondZone.auditZoneId, 'NONCONFORMITY');

    await world.request('PATCH', `${base}/evidence/${good}`, {
      token: consultantToken,
      body: { isSummaryFlagged: true },
    });

    const list = (query: string) =>
      world.request('GET', `${base}/audits/${auditId}/evidence${query}`, {
        token: world.actors.SUPER_ADMIN.accessToken,
      });

    // Everything, the selfie included.
    const all = (await list('')).body as Page<Evidence>;
    expect(all.data.map((item) => item.id)).toEqual(
      expect.arrayContaining([good, bad, other]),
    );
    expect(all.data.some((item) => item.kind === 'AUDITOR_SELFIE')).toBe(true);

    // By classification.
    const nonconformities = (await list('?classification=NONCONFORMITY')).body as Page<Evidence>;
    expect(nonconformities.data.map((item) => item.id).sort()).toEqual([bad, other].sort());

    // By Zone.
    const zoneOnly = (await list(`?auditZoneId=${secondZone.auditZoneId}`)).body as Page<Evidence>;
    expect(zoneOnly.data.map((item) => item.id)).toEqual([other]);

    // By flag — the one photograph the summary report will print for this Zone.
    const flagged = (await list('?summaryFlaggedOnly=true')).body as Page<Evidence>;
    expect(flagged.data.map((item) => item.id)).toEqual([good]);

    // And `includeDeleted=false` means what it says (`booleanQuery`, not `z.coerce`).
    await world.request('DELETE', `${base}/evidence/${bad}`, { token: consultantToken });
    const live = (await list('?includeDeleted=false')).body as Page<Evidence>;
    expect(live.data.map((item) => item.id)).not.toContain(bad);
    const withDeleted = (await list('?includeDeleted=true')).body as Page<Evidence>;
    expect(withDeleted.data.map((item) => item.id)).toContain(bad);
  });

  it('pages with a cursor that matches its own sort order', async () => {
    // §8.1 forbids offset paging on audit tables. A cursor that did not match the ORDER BY
    // would skip rows silently as the page advanced, which on an append-only table is the
    // failure cursor paging exists to prevent.
    const auditId = await startWalkBy();
    const { auditZoneId } = await addZone(auditId, await makeZone(), 1);
    const ids = [
      await photograph(auditId, auditZoneId),
      await photograph(auditId, auditZoneId),
      await photograph(auditId, auditZoneId),
    ];

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const response = await world.request(
        'GET',
        `${base}/audits/${auditId}/evidence?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        { token: world.actors.SUPER_ADMIN.accessToken },
      );
      const body = response.body as Page<Evidence>;
      seen.push(...body.data.map((item) => item.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    // The selfie plus the three photographs, each exactly once.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(ids));
    expect(seen).toHaveLength(4);
  });

  it('is closed to another Unit, and reads as absent rather than forbidden (AZ-3)', async () => {
    const auditId = await startWalkBy();
    const denied = await world.request('GET', `${base}/audits/${auditId}/evidence`, {
      token: world.outOfScopeActor.accessToken,
    });
    expect(denied.status).toBe(404);
  });
});

describe('§12.6 — the thumbnail variant', () => {
  it('falls back to the original while no thumbnail exists', async () => {
    // PART 16 wants galleries on thumbnails, but the media worker is asynchronous. A tile
    // showing the real photograph beats one showing nothing while a queue drains.
    const auditId = await startWalkBy();
    const { auditZoneId } = await addZone(auditId, await makeZone(), 1);
    const evidenceId = await photograph(auditId, auditZoneId);

    const original = await world.request('GET', `${base}/evidence/${evidenceId}/view-url`, {
      token: consultantToken,
    });
    const thumbnail = await world.request(
      'GET',
      `${base}/evidence/${evidenceId}/view-url?variant=thumbnail`,
      { token: consultantToken },
    );

    expect(original.status).toBe(200);
    expect(thumbnail.status, JSON.stringify(thumbnail.body)).toBe(200);
    // Both resolve, and both are within §12.6's 300-second cap.
    expect((thumbnail.body as EvidenceViewUrl).expiresIn).toBeLessThanOrEqual(300);

    const fetched = await world.app.inject({
      method: 'GET',
      url: (thumbnail.body as EvidenceViewUrl).url.replace(/^https?:\/\/[^/]+/, ''),
    });
    expect(fetched.statusCode).toBe(200);
  });

  it('serves the thumbnail once one is recorded', async () => {
    const auditId = await startWalkBy();
    const { auditZoneId } = await addZone(auditId, await makeZone(), 1);
    const evidenceId = await photograph(auditId, auditZoneId);

    const { rows } = await world.owner.query(
      `SELECT object_key FROM evidence WHERE id = $1`,
      [evidenceId],
    );
    const thumbnailKey = `${String(rows[0].object_key).replace(/\.jpg$/, '')}.thumb.jpg`;
    await world.owner.query(
      `UPDATE evidence SET thumbnail_object_key = $2, media_processed_at = now() WHERE id = $1`,
      [evidenceId, thumbnailKey],
    );

    const response = await world.request(
      'GET',
      `${base}/evidence/${evidenceId}/view-url?variant=thumbnail`,
      { token: consultantToken },
    );
    expect(response.status).toBe(200);
    // The filesystem driver carries the key base64url-encoded in one path segment (R-9),
    // so the assertion decodes it rather than pattern-matching the URL.
    expect(keyInUrl((response.body as EvidenceViewUrl).url)).toBe(thumbnailKey);

    // …and the original is still reachable, on the same endpoint, unchanged.
    const original = await world.request('GET', `${base}/evidence/${evidenceId}/view-url`, {
      token: consultantToken,
    });
    expect(keyInUrl((original.body as EvidenceViewUrl).url)).toBe(rows[0].object_key);
  });
});

/** The object key out of a filesystem-driver presigned URL (R-9). */
function keyInUrl(url: string): string {
  const segment = new URL(url).pathname.split('/').pop()!;
  return Buffer.from(segment, 'base64url').toString('utf8');
}
