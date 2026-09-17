import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  API_BASE_PATH,
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
  pendingOutboxCount,
  resumeCursor,
  resumeLocalAudit,
  saveLocalResponse,
  saveZoneRemark,
  scoreLocalZone,
} from '../../field-mobile/src/lib/db/audit.repository';
import { captureLocalEvidence } from '../../field-mobile/src/lib/db/evidence.repository';
import { runSync } from '../../field-mobile/src/lib/sync/engine';
import { TransportError, type SyncTransport } from '../../field-mobile/src/lib/sync/transport';
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
  return world.request(method, path, { headers: { 'x-device-id': DEVICE_ID }, ...options });
}

/** A one-by-one pixel JPEG, with real magic bytes — `commit` sniffs them (§12.8). */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/**
 * The device's transport, pointed at the test application.
 *
 * The production `SyncTransport` interface over `app.inject`. The engine cannot tell the
 * difference, which is the point: what is under test is the engine and the API, not the
 * HTTP client between them.
 */
const transport: SyncTransport = {
  async pushBatch(batch) {
    const response = await request('POST', `${base}/sync/batch`, {
      token: consultantToken,
      body: batch,
    });
    if (response.status !== 200) {
      throw new TransportError(JSON.stringify(response.body), response.status);
    }
    return response.body as Awaited<ReturnType<SyncTransport['pushBatch']>>;
  },

  async uploadIntent(payload) {
    const response = await request('POST', `${base}/evidence/upload-intent`, {
      token: consultantToken,
      body: payload,
    });
    if (response.status !== 201) {
      throw new TransportError(JSON.stringify(response.body), response.status);
    }
    return response.body as Awaited<ReturnType<SyncTransport['uploadIntent']>>;
  },

  async uploadObject(intent, _uri, contentType) {
    if (offline) {
      throw new Error('The device is offline; the object upload must not have been attempted');
    }
    const response = await world.app.inject({
      method: 'PUT',
      url: intent.uploadUrl.replace(/^https?:\/\/[^/]+/, ''),
      headers: { 'content-type': contentType },
      payload: TINY_JPEG,
    });
    if (response.statusCode !== 200) {
      throw new TransportError(response.body, response.statusCode);
    }
  },

  async status() {
    const response = await request('GET', `${base}/sync/status`, { token: consultantToken });
    return response.body as Awaited<ReturnType<SyncTransport['status']>>;
  },
};

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

    // §7.1's selfie gate is real from Phase 4 on, and the device satisfies it offline:
    // the photograph is in SQLite, and the sync engine carries it up with everything else.
    const auditId = await createLocalAudit(database, {
      unitId,
      auditType: 'EXTERNAL_5S',
      checklistVersionId: versionId,
      assignmentId,
    });
    await captureLocalEvidence(database, {
      auditId,
      kind: 'AUDITOR_SELFIE',
      localFileUri: 'file:///data/audit5s/selfie.jpg',
      byteSize: TINY_JPEG.byteLength,
      checksumSha256: createHash('sha256').update(TINY_JPEG).digest('hex'),
    });

    const auditZoneId = await addLocalZone(database, {
      auditId,
      zoneNumber: 11,
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
    //
    // Phase 3 replayed the queue through a hand-written `drainOutbox` helper, because the
    // sync engine did not exist yet. It does now, so this drives the real one — the same
    // module the app runs — and the helper is gone.
    offline = false;

    let cycles = 0;
    let pending = await pendingOutboxCount(database);
    while (pending > 0 && cycles < 10) {
      await runSync(database, transport, { deviceId: DEVICE_ID });
      pending = await pendingOutboxCount(database);
      cycles += 1;
    }
    // Named rather than counted when it fails: "3 items remain" sends the next reader to
    // the debugger, and "audit:pause DEAD_LETTER — not a transition this machine defines"
    // sends them to the bug.
    const stuck = (await listOutbox(database)).filter((item) => item.state !== 'SYNCED');
    expect(
      pending,
      `the outbox still holds ${pending} item(s) after ${cycles} cycles:\n` +
        stuck
          .map((item) => `  ${item.entityType}:${item.operation} ${item.state} — ${item.lastError ?? 'no error recorded'}`)
          .join('\n'),
    ).toBe(0);

    // The abort reached the server — that is what makes a replaced device able to pick the
    // audit up rather than start it again.
    //
    // Asserted on the *verdict* rather than on the cursor column, and deliberately: by the
    // time the queue has fully drained the Zone is COMPLETED, and a finished Zone has no
    // resume cursor to hold. The clause the acceptance row actually states — "Abort saves
    // and resumes at the same question" — is asserted above, on the device, at the moment
    // it happens.
    const { rows: batches } = await world.owner.query(
      `SELECT results FROM device_sync_record WHERE device_id = $1 ORDER BY started_at`,
      [DEVICE_ID],
    );
    const verdicts = batches.flatMap(
      (batch) => (batch.results ?? []) as Array<{ entityId: string; status: string }>,
    );
    const pauseVerdict = verdicts.find((verdict) => verdict.entityId === auditId);
    expect(pauseVerdict, 'the abort never reached the server').toBeTruthy();
    expect(verdicts.some((verdict) => verdict.status === 'REJECTED')).toBe(false);

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
    // No photograph means no nonconformity to act on, so §7.1 closes it on completion.
    expect(completed.status).toBe('CLOSED');
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
