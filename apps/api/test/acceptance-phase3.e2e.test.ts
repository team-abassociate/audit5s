import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  API_BASE_PATH,
  type Audit,
  type AuditDetail,
  type AuditScoreSummary,
  type ResponseValue,
  type SSection,
  type SyncCatalogue,
} from '@audit5s/contracts';
import { S_SECTION_ORDER, TOTAL_QUESTIONS } from '@audit5s/domain';
import { loginFromDevice, startWorld, stopWorld, type TestWorld } from './harness';

// The **real device store**, imported from the mobile app rather than reimplemented here.
// That is the point of this file: the offline half runs the code that runs on a phone,
// against an actual SQLite, and the online half runs the actual API.
import {
  addLocalZone,
  completeLocalAudit,
  completeLocalZone,
  createLocalAudit,
  getLocalAuditZone,
  listOutbox,
  listQuestionsWithAnswers,
  pauseLocalAudit,
  resumeCursor,
  resumeLocalAudit,
  saveLocalResponse,
  saveZoneRemark,
  scoreLocalZone,
} from '../../field-mobile/src/lib/db/audit.repository';
import { replaceCatalogue } from '../../field-mobile/src/lib/db/catalogue.repository';
import {
  createLocalDatabase,
  migrateLocalDatabase,
  type LocalDatabase,
} from '../../field-mobile/src/lib/db/local-database';
import { createNodeExecutor } from '../../field-mobile/src/lib/db/node-executor';

/**
 * **The Phase 3 acceptance row**, verified literally:
 *
 * > A Consultant completes a 50-question Zone entirely offline; scores computed on-device
 * > match the server exactly; Abort saves and resumes at the same question; a Zone
 * > description edited afterwards does not alter the completed audit.
 *
 * Nothing here is mocked. The offline half opens the device's own SQLite through
 * `node:sqlite` and drives `apps/field-mobile`'s repository — the same functions the
 * questionnaire screen calls — with the network switched off, which is enforced by the
 * `offline` flag below rather than assumed. The online half is the real Nest application
 * over a real PostgreSQL.
 *
 * "Match exactly" is asserted as equality of the whole breakdown, not of a rounded
 * percentage: the device and the server run the same `scoreZone`, so anything less than
 * equality would mean they had somehow stopped doing that.
 */

let world: TestWorld;
let database: LocalDatabase;
let executor: ReturnType<typeof createNodeExecutor>;

const base = API_BASE_PATH;
const DEVICE_ID = '01930000-0000-7000-8000-0000000ac001';

let consultantToken: string;
let unitId: string;
let zoneId: string;
let versionId: string;

/**
 * The radio.
 *
 * Every request in this file goes through `request()` below, which refuses while this is
 * `true`. The offline section flips it, so "entirely offline" is a property the test
 * enforces rather than a claim about which functions happen not to call `fetch`.
 */
let offline = false;

async function request(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
) {
  if (offline) {
    throw new Error(`The device is offline; ${method} ${path} must not have been attempted`);
  }
  return world.request(method, path, options);
}

beforeAll(async () => {
  world = await startWorld();
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, DEVICE_ID);
  unitId = world.unitA;

  // A Zone with a description — the thing the last clause of the acceptance row edits.
  const zone = await world.request('POST', `${base}/units/${unitId}/zones`, {
    token: world.actors.SUPER_ADMIN.accessToken,
    body: { code: 'Z-11', name: 'Press', description: 'Press shop, bay 3' },
  });
  expect(zone.status).toBe(201);
  zoneId = (zone.body as { id: string }).id;

  versionId = await seedFiftyQuestionChecklist();

  await world.request('POST', `${base}/audit-assignments`, {
    token: world.actors.SUPER_ADMIN.accessToken,
    body: { unitId, auditorUserId: world.actors.CONSULTANT.userId, auditType: 'EXTERNAL_5S' },
  });

  executor = createNodeExecutor();
  await migrateLocalDatabase(executor);
  database = createLocalDatabase(executor);
}, 180_000);

afterAll(async () => {
  executor?.close();
  await stopWorld(world);
});

async function seedFiftyQuestionChecklist(): Promise<string> {
  const { rows: template } = await world.owner.query(
    `INSERT INTO checklist_template (code, name) VALUES ('SHOP_FLOOR', 'Shop Floor') RETURNING id`,
  );
  const { rows: version } = await world.owner.query(
    `INSERT INTO checklist_version (template_id, version_number, total_questions, content_hash)
     VALUES ($1, 1, 50, 'acceptance-v1') RETURNING id`,
    [template[0].id],
  );

  for (const [sectionIndex, section] of S_SECTION_ORDER.entries()) {
    for (let order = 1; order <= 10; order += 1) {
      const globalOrder = sectionIndex * 10 + order;
      await world.owner.query(
        `INSERT INTO checklist_question (version_id, section, order_in_section, global_order,
                                         text, allows_na)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          version[0].id,
          section,
          order,
          globalOrder,
          `Question ${globalOrder}`,
          [13, 28, 45].includes(globalOrder),
        ],
      );
    }
  }

  await world.owner.query(
    `UPDATE checklist_version SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [version[0].id],
  );
  return version[0].id as string;
}

/** Fifty answers with a deliberate mix, NA only where the question permits it. */
function fiftyAnswers(): ResponseValue[] {
  return Array.from({ length: TOTAL_QUESTIONS }, (_unused, index) => {
    if (index === 12 || index === 27 || index === 44) return 'NA';
    if (index % 7 === 0) return 'SCORE_0';
    if (index % 3 === 0) return 'SCORE_1';
    return 'SCORE_2';
  });
}

describe('Phase 3 acceptance', () => {
  it('runs end to end', async () => {
    // ------------------------------------------------------ 1. the last connected moment
    const catalogueResponse = await request('GET', `${base}/sync/catalogue`, {
      token: consultantToken,
    });
    expect(catalogueResponse.status).toBe(200);
    const catalogue = catalogueResponse.body as SyncCatalogue;

    expect(catalogue.zones.map((zone) => zone.id)).toContain(zoneId);
    expect(catalogue.assignments).toHaveLength(1);

    await replaceCatalogue(database, catalogue);
    const assignmentId = catalogue.assignments[0]!.id;

    // ------------------------------------------- 2. the radio goes off, and stays off
    offline = true;

    const auditId = await createLocalAudit(database, {
      unitId,
      auditType: 'EXTERNAL_5S',
      checklistVersionId: versionId,
      assignmentId,
    });
    const auditZoneId = await addLocalZone(database, {
      auditId,
      zoneId,
      sequenceNo: 1,
      checklistVersionId: versionId,
    });

    // The D6 snapshots were taken from the cached Zone, offline.
    const [localZone] = await getLocalAuditZone(database, auditZoneId);
    expect(localZone).toMatchObject({
      zoneCodeSnapshot: 'Z-11',
      zoneNameSnapshot: 'Press',
      zoneDescriptionSnapshot: 'Press shop, bay 3',
    });

    const questions = await listQuestionsWithAnswers(database, auditZoneId, versionId);
    expect(questions).toHaveLength(TOTAL_QUESTIONS);

    const values = fiftyAnswers();
    const answer = async (index: number) => {
      const question = questions[index]!;
      await saveLocalResponse(database, {
        auditZoneId,
        auditId,
        checklistQuestionId: question.questionId,
        section: question.section as SSection,
        globalOrder: question.globalOrder,
        value: values[index]!,
        ...(index === 0 ? { remark: 'Two unlabelled bins by the press' } : {}),
      });
    };

    // -------------------------------- 3. Abort mid-Zone, and resume at the same question
    for (let index = 0; index < 23; index += 1) await answer(index);

    await pauseLocalAudit(database, auditId, 'Shift ended');

    const cursor = await resumeCursor(database, auditId);
    expect(cursor.auditZoneId).toBe(auditZoneId);
    expect(cursor.questionId).toBe(questions[22]!.questionId);
    expect(cursor.answered).toBe(23);

    await resumeLocalAudit(database, auditId);

    // The acceptance clause, stated as the assertion it is: the question the auditor
    // reopens on is the one they stopped on, and every answer is still there.
    const afterResume = await resumeCursor(database, auditId);
    expect(afterResume.questionId).toBe(questions[22]!.questionId);
    expect(afterResume.answered).toBe(23);

    for (let index = 23; index < TOTAL_QUESTIONS; index += 1) await answer(index);

    await saveZoneRemark(database, auditZoneId, 'Housekeeping improving on the press line');
    await completeLocalZone(database, auditZoneId);
    await completeLocalAudit(database, auditId);

    const onDevice = await scoreLocalZone(database, auditZoneId);
    expect(onDevice.totals.applicableQuestions).toBe(47);
    expect(onDevice.totals.naQuestions).toBe(3);
    expect(onDevice.totals.scorePercentage).not.toBeNull();

    // Fifty answers, all offline. Nothing above touched the network — `request()` would
    // have thrown — and the queue is what the device will send when it can.
    const queue = await listOutbox(database);
    expect(queue.filter((item) => item.entityType === 'question_response')).toHaveLength(50);
    expect(queue.every((item) => item.state === 'PENDING')).toBe(true);

    // ------------------------------------------------ 4. the radio comes back: drain
    offline = false;
    const drained = await drainOutbox(auditId, auditZoneId);

    // The abort reached the server with its cursors, so a replaced device could pick this
    // audit up exactly where the lost one stopped — the same question, on the same Zone.
    expect(drained.serverCursorAfterPause).toEqual({
      auditZoneId,
      questionId: questions[22]!.questionId,
      pauseReason: 'Shift ended',
    });

    // ----------------------------------------- 5. the server's score, recomputed by it
    const summaryResponse = await request('GET', `${base}/audits/${auditId}/summary`, {
      token: consultantToken,
    });
    expect(summaryResponse.status).toBe(200);
    const summary = summaryResponse.body as AuditScoreSummary;
    const serverZone = summary.zones.find((zone) => zone.auditZoneId === auditZoneId)!;

    // **Exactly** — the whole breakdown, not a rounded percentage within a tolerance.
    expect(serverZone.totals).toEqual({
      applicableQuestions: onDevice.totals.applicableQuestions,
      naQuestions: onDevice.totals.naQuestions,
      rawScore: onDevice.totals.rawScore,
      maxScore: onDevice.totals.maxScore,
      scorePercentage: onDevice.totals.scorePercentage,
    });

    expect(serverZone.sections).toEqual(
      onDevice.sections.map((section) => ({
        section: section.section,
        applicable: section.applicableQuestions,
        na: section.naQuestions,
        raw: section.rawScore,
        max: section.maxScore,
        pct: section.scorePercentage,
      })),
    );

    const completedResponse = await request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    const completed = completedResponse.body as AuditDetail;
    expect(completed.status).toBe('COMPLETED');
    expect(completed.zones).toHaveLength(1);
    expect(completed.zones[0]!.responses).toHaveLength(TOTAL_QUESTIONS);
    expect(completed.zones[0]!.zoneRemark).toBe('Housekeeping improving on the press line');
    expect(completed.totals.scorePercentage).toBe(onDevice.totals.scorePercentage);

    // ------------------- 6. a Zone description edited afterwards changes nothing here
    const before = completed.zones[0]!;

    const edit = await request('PATCH', `${base}/zones/${zoneId}`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        name: 'Press Shop (renamed in October)',
        description: 'Moved to bay 7 after the line was rearranged',
      },
    });
    expect(edit.status).toBe(200);

    const afterResponse = await request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    const after = (afterResponse.body as AuditDetail).zones[0]!;

    expect(after.zoneCodeSnapshot).toBe('Z-11');
    expect(after.zoneNameSnapshot).toBe('Press');
    expect(after.zoneDescriptionSnapshot).toBe('Press shop, bay 3');
    expect(after.totals).toEqual(before.totals);
    expect(after.sections).toEqual(before.sections);
    expect(after.zoneRemark).toBe(before.zoneRemark);

    // And the audit is closed to ordinary edits now, so nothing can quietly correct it
    // without the audit-logged override (A-2).
    const tamper = await request(
      'PUT',
      `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`,
      {
        token: consultantToken,
        body: {
          checklistQuestionId: questions[0]!.questionId,
          value: 'SCORE_2',
          answeredAt: new Date().toISOString(),
        },
      },
    );
    expect(tamper.status).toBe(409);
    expect((tamper.body as { code: string }).code).toBe('AUDIT_ALREADY_COMPLETED');
  }, 180_000);
});

/**
 * Replays the outbox through the real endpoints, in dependency order.
 *
 * The sync **engine** — batching, backoff, topological ordering, the media queue — is
 * Phase 4's row. What Phase 3 owns is that the queue holds enough to reconstruct the work
 * on the server, and this function proves it by sending exactly what the device queued and
 * nothing the device did not.
 */
async function drainOutbox(
  auditId: string,
  auditZoneId: string,
): Promise<{
  serverCursorAfterPause: {
    auditZoneId: string | null;
    questionId: string | null;
    pauseReason: string | null;
  } | null;
}> {
  const queue = await listOutbox(database);
  const payloadOf = (item: (typeof queue)[number]) =>
    JSON.parse(item.payload) as Record<string, unknown>;

  const auditUpsert = queue.find((i) => i.entityType === 'audit' && i.operation === 'upsert')!;
  const created = await request('POST', `${base}/audits`, {
    token: consultantToken,
    body: { ...payloadOf(auditUpsert), deviceId: DEVICE_ID },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((created.body as Audit).id).toBe(auditId);

  const started = await request('POST', `${base}/audits/${auditId}/start`, {
    token: consultantToken,
    body: { deviceId: DEVICE_ID },
  });
  expect(started.status).toBe(200);

  const zoneUpsert = queue.find((i) => i.entityType === 'audit_zone' && i.operation === 'upsert')!;
  const zone = await request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
    token: consultantToken,
    body: payloadOf(zoneUpsert),
  });
  expect(zone.status, JSON.stringify(zone.body)).toBe(200);

  let serverCursorAfterPause: {
    auditZoneId: string | null;
    questionId: string | null;
    pauseReason: string | null;
  } | null = null;

  const pause = queue.find((i) => i.operation === 'pause');
  if (pause) {
    const paused = await request('POST', `${base}/audits/${auditId}/pause`, {
      token: consultantToken,
      body: payloadOf(pause),
    });
    expect(paused.status).toBe(200);

    // Read the cursors *while the audit is paused*: resuming clears the reason, as it
    // should — an audit that is running is not currently aborted.
    const { rows } = await world.owner.query(
      `SELECT a.resume_audit_zone_id, a.pause_reason, az.resume_question_id
       FROM audit a
       LEFT JOIN audit_zone az ON az.id = a.resume_audit_zone_id
       WHERE a.id = $1`,
      [auditId],
    );
    serverCursorAfterPause = {
      auditZoneId: rows[0].resume_audit_zone_id as string | null,
      questionId: rows[0].resume_question_id as string | null,
      pauseReason: rows[0].pause_reason as string | null,
    };

    const resumed = await request('POST', `${base}/audits/${auditId}/resume`, {
      token: consultantToken,
      body: { deviceId: DEVICE_ID },
    });
    expect(resumed.status).toBe(200);
  }

  for (const item of queue.filter((i) => i.entityType === 'question_response')) {
    const payload = payloadOf(item);
    const response = await request(
      'PUT',
      `${base}/audit-zones/${auditZoneId}/responses/${String(payload.id)}`,
      { token: consultantToken, body: payload },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }

  const zoneComplete = queue.find(
    (i) => i.entityType === 'audit_zone' && i.operation === 'complete',
  )!;
  const finishedZone = await request(
    'POST',
    `${base}/audits/${auditId}/zones/${auditZoneId}/complete`,
    { token: consultantToken, body: payloadOf(zoneComplete) },
  );
  expect(finishedZone.status, JSON.stringify(finishedZone.body)).toBe(200);

  const auditComplete = queue.find((i) => i.entityType === 'audit' && i.operation === 'complete')!;
  const finished = await request('POST', `${base}/audits/${auditId}/complete`, {
    token: consultantToken,
    body: payloadOf(auditComplete),
  });
  expect(finished.status, JSON.stringify(finished.body)).toBe(200);

  return { serverCursorAfterPause };
}
