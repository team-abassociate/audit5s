import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  type AuditDetail,
  type AuditScoreSummary,
  type Page,
  type ResponseValue,
  type SSection,
  type SyncBatchRequest,
  type SyncBatchResponse,
  type SyncCatalogue,
  type SyncConflict,
  type SyncStatus,
  type UploadIntentResponse,
} from '@audit5s/contracts';
import { S_SECTION_ORDER, TOTAL_QUESTIONS } from '@audit5s/domain';
import { loginFromDevice, startWorld, stopWorld, type TestWorld } from './harness';

// The **real device store and the real sync engine**, imported from the mobile app rather
// than reimplemented here. Phase 3's acceptance test drove the queue by hand through a
// `drainOutbox` helper; that helper is gone, and this file drives the engine that shipped.
import {
  addLocalZone,
  completeLocalAudit,
  completeLocalZone,
  createLocalAudit,
  listOutbox,
  listQuestionsWithAnswers,
  pendingOutboxCount,
  saveLocalResponse,
  saveZoneRemark,
  scoreLocalZone,
} from '../../field-mobile/src/lib/db/audit.repository';
import {
  captureLocalEvidence,
  listLocalEvidenceForZone,
} from '../../field-mobile/src/lib/db/evidence.repository';
import { replaceCatalogue } from '../../field-mobile/src/lib/db/catalogue.repository';
import {
  createLocalDatabase,
  migrateLocalDatabase,
  type LocalDatabase,
} from '../../field-mobile/src/lib/db/local-database';
import { createNodeExecutor } from '../../field-mobile/src/lib/db/node-executor';
import { runSync } from '../../field-mobile/src/lib/sync/engine';
import { TransportError, type SyncTransport } from '../../field-mobile/src/lib/sync/transport';
import { checkLogoutGate, readSyncStatus } from '../../field-mobile/src/lib/sync/status';

/**
 * **The Phase 4 acceptance row**, verified literally:
 *
 * > A three-Zone audit captured with the radio off syncs completely and correctly on
 * > reconnect; a duplicated sync creates nothing extra; every rejected item is visible in
 * > the conflict queue with its full payload.
 *
 * Nothing here is mocked. The offline half opens the device's own SQLite through
 * `node:sqlite` and drives `apps/field-mobile`'s repositories and **sync engine** — the
 * same code that runs on a phone. The online half is the real Nest application over a real
 * PostgreSQL, reached through a transport that makes the same HTTP calls the app makes.
 *
 * "With the radio off" is *enforced*, not assumed: the `offline` flag below makes every
 * request throw, so a function that quietly reached for the network would fail the test
 * rather than pass it silently.
 */

let world: TestWorld;
let database: LocalDatabase;
let executor: ReturnType<typeof createNodeExecutor>;

const base = API_BASE_PATH;
const DEVICE_ID = '01930000-0000-7000-8000-0000000a4001';

let consultantToken: string;
let unitId: string;
let versionId: string;
const zoneIds: string[] = [];

/**
 * The radio.
 *
 * Every call the transport makes goes through `call()` below, which refuses while this is
 * `true`. The offline section flips it, so "entirely offline" is a property this file
 * enforces rather than a claim about which functions happen not to call `fetch`.
 */
let offline = false;

/** A one-by-one pixel JPEG, with real magic bytes — `commit` sniffs them (§12.8). */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  if (offline) {
    throw new Error(`The device is offline; ${method} ${path} must not have been attempted`);
  }
  return world.request(method, path, {
    token: consultantToken,
    headers: { 'x-device-id': DEVICE_ID, ...(options.headers ?? {}) },
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

/**
 * The device's transport, pointed at the test application.
 *
 * It is the production `SyncTransport` interface, implemented over `app.inject` instead of
 * `fetch`. The engine cannot tell the difference, which is the point: what is under test is
 * the engine and the API, not the HTTP client between them.
 */
const transport: SyncTransport = {
  async pushBatch(request: SyncBatchRequest): Promise<SyncBatchResponse> {
    const response = await call('POST', `${base}/sync/batch`, { body: request });
    if (response.status !== 200) {
      throw new TransportError(JSON.stringify(response.body), response.status);
    }
    return response.body as SyncBatchResponse;
  },

  async uploadIntent(payload): Promise<UploadIntentResponse> {
    const response = await call('POST', `${base}/evidence/upload-intent`, { body: payload });
    if (response.status !== 201) {
      throw new TransportError(JSON.stringify(response.body), response.status);
    }
    return response.body as UploadIntentResponse;
  },

  async uploadObject(intent, _localFileUri, contentType): Promise<void> {
    if (offline) {
      throw new Error('The device is offline; the object upload must not have been attempted');
    }
    // Straight to the presigned URL, carrying no session — exactly as §5 requires and as
    // the device's own transport does.
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

  async status(): Promise<SyncStatus> {
    const response = await call('GET', `${base}/sync/status`);
    return response.body as SyncStatus;
  },
};

/** The engine, with the device's own id — one cycle. */
const sync = () => runSync(database, transport, { deviceId: DEVICE_ID, appVersion: '1.4.2' });

beforeAll(async () => {
  world = await startWorld();
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, DEVICE_ID);
  unitId = world.unitA;

  for (const [index, name] of ['Press', 'Assembly', 'Stores'].entries()) {
    const zone = await world.request('POST', `${base}/units/${unitId}/zones`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        code: `Z-4${index + 1}`,
        name,
        description: `${name} shop, bay ${index + 1}`,
      },
    });
    expect(zone.status, JSON.stringify(zone.body)).toBe(201);
    zoneIds.push((zone.body as { id: string }).id);
  }

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
     VALUES ($1, 1, 50, 'phase4-v1') RETURNING id`,
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
function fiftyAnswers(offsetSeed: number): ResponseValue[] {
  return Array.from({ length: TOTAL_QUESTIONS }, (_unused, index) => {
    if (index === 12 || index === 27 || index === 44) return 'NA';
    if ((index + offsetSeed) % 7 === 0) return 'SCORE_0';
    if ((index + offsetSeed) % 3 === 0) return 'SCORE_1';
    return 'SCORE_2';
  });
}

let auditId = '';
const auditZoneIds: string[] = [];
const onDeviceScores: Array<Awaited<ReturnType<typeof scoreLocalZone>>> = [];

describe('Phase 4 acceptance', () => {
  it('captures three Zones with the radio off and syncs them completely', async () => {
    // ---------------------------------------------------- 1. the last connected moment
    const catalogueResponse = await call('GET', `${base}/sync/catalogue`);
    expect(catalogueResponse.status).toBe(200);
    const catalogue = catalogueResponse.body as SyncCatalogue;
    expect(catalogue.zones.map((zone) => zone.id)).toEqual(expect.arrayContaining(zoneIds));

    await replaceCatalogue(database, catalogue);
    const assignmentId = catalogue.assignments[0]!.id;

    // ------------------------------------------- 2. the radio goes off, and stays off
    offline = true;

    auditId = await createLocalAudit(database, {
      unitId,
      auditType: 'EXTERNAL_5S',
      checklistVersionId: versionId,
      assignmentId,
    });

    // The selfie §7.1 requires, captured on the device before anything else.
    await captureLocalEvidence(database, {
      auditId,
      kind: 'AUDITOR_SELFIE',
      localFileUri: 'file:///data/audit5s/selfie.jpg',
      byteSize: TINY_JPEG.byteLength,
      checksumSha256: createHash('sha256').update(TINY_JPEG).digest('hex'),
      location: { latitude: 19.9975, longitude: 73.7898, accuracyM: 12, provider: 'FUSED' },
    });

    for (const index of zoneIds.keys()) {
      const auditZoneId = await addLocalZone(database, {
        auditId,
        zoneNumber: 41 + index,
        sequenceNo: index + 1,
        checklistVersionId: versionId,
      });
      auditZoneIds.push(auditZoneId);

      const questions = await listQuestionsWithAnswers(database, auditZoneId, versionId);
      expect(questions).toHaveLength(TOTAL_QUESTIONS);

      const values = fiftyAnswers(index);
      for (const [position, question] of questions.entries()) {
        await saveLocalResponse(database, {
          auditZoneId,
          auditId,
          checklistQuestionId: question.questionId,
          section: question.section as SSection,
          globalOrder: question.globalOrder,
          value: values[position]!,
          ...(position === 0 ? { remark: `Zone ${index + 1}: two unlabelled bins` } : {}),
        });
      }

      // One photograph per Zone, attached to the first question.
      await captureLocalEvidence(database, {
        auditId,
        auditZoneId,
        kind: 'QUESTION_EVIDENCE',
        scoreAtCapture: values[0]!,
        localFileUri: `file:///data/audit5s/zone-${index + 1}.jpg`,
        byteSize: TINY_JPEG.byteLength,
        checksumSha256: createHash('sha256').update(TINY_JPEG).digest('hex'),
      });

      await saveZoneRemark(database, auditZoneId, `Zone ${index + 1} remark`);
      await completeLocalZone(database, auditZoneId);
      onDeviceScores.push(await scoreLocalZone(database, auditZoneId));
    }

    await completeLocalAudit(database, auditId);

    // 150 answers, three Zones, four photographs — all offline. Nothing above touched the
    // network; `call()` would have thrown.
    const queue = await listOutbox(database);
    expect(queue.filter((item) => item.entityType === 'question_response')).toHaveLength(150);
    expect(queue.filter((item) => item.queue === 'media')).toHaveLength(4);
    expect(await pendingOutboxCount(database)).toBeGreaterThan(150);

    // §9.7: logout is blocked while any of it is unsynced, and the message says how much.
    const gate = await checkLogoutGate(database);
    expect(gate.blocked).toBe(true);
    expect(gate.message).toContain('unsynced item');
    expect(gate.pendingPhotos).toBe(4);

    // ------------------------------------ 3. the radio comes back: the engine drains it
    offline = false;

    // More than one cycle, deliberately. A batch is capped at 100 items (§9.3), and a
    // device with 150 answers has to come back for the rest — which is the ordinary case,
    // not an edge one.
    let cycles = 0;
    let pending = await pendingOutboxCount(database);
    while (pending > 0 && cycles < 10) {
      await sync();
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

    // ------------------------------------------ 4. "completely and correctly", asserted
    const detailResponse = await call('GET', `${base}/audits/${auditId}`);
    expect(detailResponse.status).toBe(200);
    const detail = detailResponse.body as AuditDetail;

    // §7.1: completed, then rolled on — CLOSED, as none of its photographs is a finding.
    expect(detail.status).toBe('CLOSED');
    expect(detail.zones).toHaveLength(3);
    for (const zone of detail.zones) {
      expect(zone.responses).toHaveLength(TOTAL_QUESTIONS);
      expect(zone.status).toBe('COMPLETED');
      expect(zone.zoneRemark).toMatch(/^Zone \d remark$/);
    }

    // The scores the auditor saw offline are the ones the server stored — the same
    // `scoreZone`, over the same answers, so equality of the whole breakdown rather than
    // a rounded percentage within a tolerance.
    const summaryResponse = await call('GET', `${base}/audits/${auditId}/summary`);
    const summary = summaryResponse.body as AuditScoreSummary;

    for (const [index, auditZoneId] of auditZoneIds.entries()) {
      const serverZone = summary.zones.find((zone) => zone.auditZoneId === auditZoneId)!;
      const onDevice = onDeviceScores[index]!;

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
    }

    // The four photographs arrived, with their objects verified (§9.4): the selfie and one
    // per Zone. `SYNCED` means the server HEAD'd the object and matched its checksum.
    const { rows: evidenceRows } = await world.owner.query(
      `SELECT kind, sync_state, classification, uploaded_at IS NOT NULL AS uploaded
       FROM evidence WHERE audit_id = $1 ORDER BY kind`,
      [auditId],
    );
    expect(evidenceRows).toHaveLength(4);
    expect(evidenceRows.every((row) => row.sync_state === 'SYNCED' && row.uploaded)).toBe(true);
    expect(evidenceRows.filter((row) => row.kind === 'AUDITOR_SELFIE')).toHaveLength(1);

    // The device agrees: nothing is still waiting, and logout is no longer blocked.
    const status = await readSyncStatus(database);
    expect(status.dot).toBe('synced');
    expect(status.pendingItems).toBe(0);
    expect((await checkLogoutGate(database)).blocked).toBe(false);

    const serverStatus = await transport.status();
    expect(serverStatus.awaitingUploadCount).toBe(0);
    // Completing the audit released the D7 lock (§9.5 Layer 1).
    expect(serverStatus.ownedAudits.map((audit) => audit.auditId)).not.toContain(auditId);
  }, 300_000);

  it('creates nothing extra when the identical batch is replayed', async () => {
    // A device that pushed successfully and never heard the answer: same batch id, same
    // items. §9.3's guarantee is that this changes nothing at all.
    const before = await countRows();

    const { rows: batches } = await world.owner.query(
      `SELECT batch_id, results FROM device_sync_record
       WHERE device_id = $1 ORDER BY started_at ASC`,
      [DEVICE_ID],
    );
    expect(batches.length).toBeGreaterThan(0);

    for (const batch of batches) {
      const items = (batch.results as Array<{ outboxId: string; entityId: string }>).map(
        (result) => ({
          outboxId: result.outboxId,
          // The entity types are recovered from the audit we just synced; what matters is
          // that the *batch id* is the same, because that is what §9.3 dedupes on.
          entityType: 'question_response' as const,
          entityId: result.entityId,
          operation: 'upsert' as const,
          payload: {},
        }),
      );

      const replayed = await call('POST', `${base}/sync/batch`, {
        body: {
          batchId: batch.batch_id,
          deviceId: DEVICE_ID,
          items: items.length > 0 ? items : [
            {
              outboxId: randomUUID(),
              entityType: 'audit',
              entityId: auditId,
              operation: 'upsert',
              payload: {},
            },
          ],
        },
      });

      expect(replayed.status).toBe(200);
      const body = replayed.body as SyncBatchResponse;
      expect(body.replayed).toBe(true);
      // The stored verdicts, not recomputed ones — recomputing would mean applying again.
      expect(body.results).toEqual(batch.results);
    }

    expect(await countRows()).toEqual(before);
  }, 180_000);

  it('creates nothing extra when the same work is re-queued under a new batch id', async () => {
    // The other duplicate: a device whose outbox was rebuilt — new batch, new outbox ids,
    // the same audit content. The rows are idempotent even when the batch is not.
    const before = await countRows();

    const questions = await listQuestionsWithAnswers(database, auditZoneIds[0]!, versionId);
    // The remark comes along, because §9.5's rule is "byte-identical → DUPLICATE" and an
    // item that drops a field the stored row has is not identical — it is a different
    // answer, and quarantining it is the correct behaviour, not a false positive.
    const { rows: existing } = await world.owner.query(
      `SELECT id, checklist_question_id, value, remark FROM question_response
       WHERE audit_zone_id = $1 ORDER BY global_order LIMIT 5`,
      [auditZoneIds[0]],
    );

    const response = await call('POST', `${base}/sync/batch`, {
      body: {
        batchId: randomUUID(),
        deviceId: DEVICE_ID,
        items: existing.map((row) => ({
          outboxId: randomUUID(),
          entityType: 'question_response',
          entityId: row.id,
          operation: 'upsert',
          payload: {
            auditZoneId: auditZoneIds[0],
            checklistQuestionId: row.checklist_question_id,
            value: row.value,
            remark: row.remark,
            answeredAt: new Date().toISOString(),
          },
        })),
      },
    });

    expect(response.status).toBe(200);
    const body = response.body as SyncBatchResponse;
    expect(body.replayed).toBe(false);
    // The audit is completed, and these are byte-identical, so §9.5 accepts them silently
    // as DUPLICATE rather than quarantining a no-op for a human to review.
    expect(
      body.results.map((result) => result.status),
      JSON.stringify(body.results, null, 2),
    ).toEqual(body.results.map(() => 'DUPLICATE'));

    expect(await countRows()).toEqual(before);
    expect(questions).toHaveLength(TOTAL_QUESTIONS);
  }, 180_000);

  it('holds a rejected item in the conflict queue with its payload intact', async () => {
    // A deliberately poisoned item: a response value outside the enum, for a Zone that
    // exists. It must not be applied, it must not be silently dropped, and the payload
    // must survive whole — "the system has no code path that drops field data on the
    // floor" is the single most important property of the design (§9.5).
    const poisoned = {
      auditZoneId: auditZoneIds[1],
      checklistQuestionId: (await listQuestionsWithAnswers(database, auditZoneIds[1]!, versionId))[0]!
        .questionId,
      value: 'SCORE_SEVENTEEN',
      remark: 'Third rack from the door, second shelf — bin unlabelled since Tuesday',
      answeredAt: new Date().toISOString(),
    };

    const response = await call('POST', `${base}/sync/batch`, {
      body: {
        batchId: randomUUID(),
        deviceId: DEVICE_ID,
        items: [
          {
            outboxId: randomUUID(),
            entityType: 'question_response',
            entityId: randomUUID(),
            operation: 'upsert',
            payload: poisoned,
          },
        ],
      },
    });

    expect(response.status).toBe(200);
    const verdict = (response.body as SyncBatchResponse).results[0]!;
    expect(verdict.status).toBe('REJECTED');
    expect(verdict.conflictId).toBeTruthy();
    expect(verdict.errors?.join(' ')).toMatch(/value/i);

    // Visible in the queue a Super Admin reads.
    const queue = await world.request('GET', `${base}/sync-conflicts?limit=200`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    const conflicts = (queue.body as Page<SyncConflict>).data;
    const mine = conflicts.find((conflict) => conflict.id === verdict.conflictId);
    expect(mine, 'the rejected item is not in the conflict queue').toBeTruthy();

    // …with the **full** payload, field for field, including the auditor's own words.
    expect(mine!.incomingPayload).toEqual(poisoned);
    expect(mine!.reason).toBe('VALIDATION_FAILED');
    expect(mine!.deviceId).toBe(DEVICE_ID);
    expect(mine!.resolvedAt).toBeNull();

    // And nothing of it reached the audit.
    const { rows } = await world.owner.query(
      `SELECT COUNT(*)::int AS count FROM question_response WHERE remark = $1`,
      [poisoned.remark],
    );
    expect(rows[0].count).toBe(0);
  }, 180_000);

  it('leaves the device’s own record of the work intact throughout', async () => {
    // The device keeps its rows after a successful sync — §9.4 retains the local files for
    // seven days so a report can be previewed offline, and the rows outlive the queue.
    for (const auditZoneId of auditZoneIds) {
      expect(await listLocalEvidenceForZone(database, auditZoneId)).toHaveLength(1);
    }

    const local = await scoreLocalZone(database, auditZoneIds[0]!);
    expect(local.totals.applicableQuestions).toBe(47);
    expect(local.totals.naQuestions).toBe(3);
  });
});

/** The row counts that must not move when a duplicate arrives. */
async function countRows(): Promise<Record<string, number>> {
  const { rows } = await world.owner.query(
    `SELECT
       (SELECT COUNT(*)::int FROM audit) AS audits,
       (SELECT COUNT(*)::int FROM audit_zone) AS zones,
       (SELECT COUNT(*)::int FROM question_response) AS responses,
       (SELECT COUNT(*)::int FROM evidence) AS evidence`,
  );
  return rows[0] as Record<string, number>;
}
