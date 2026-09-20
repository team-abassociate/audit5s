import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  type Audit,
  type Device,
  type Page,
  type SyncBatchRequest,
  type SyncBatchResponse,
  type SyncConflict,
  type SyncStatus,
} from '@audit5s/contracts';
import { S_SECTION_ORDER } from '@audit5s/domain';
import { captureEvidence, loginFromDevice, startWorld, stopWorld, type TestWorld } from './harness';

/**
 * `POST /sync/batch` and everything around it (§8.11, §9.3, §9.5).
 *
 * The cases here are the ones PART 14's Phase 4 test row names: a duplicate batch creating
 * no duplicates, a 100-item batch with one invalid item accepting 99, a second device
 * conflicting and quarantining, clock-skew normalization, and the device-lock release.
 *
 * The acceptance row's own scenario — three Zones captured with the radio off, driven by
 * the *real* device sync engine — is `acceptance-phase4.e2e.test.ts`. This file tests the
 * server's half in isolation, so a failure in either says which half.
 */

let world: TestWorld;
const base = API_BASE_PATH;

const DEVICE_ID = '01930000-0000-7000-8000-00000000bc01';
const SECOND_DEVICE = '01930000-0000-7000-8000-00000000bc02';

let consultantToken: string;
/**
 * The second device's token, obtained **once**.
 *
 * §12.11 rate-limits per login ID, and a suite that signs in for every case trips its own
 * lockout — which is the control working, not a flake to retry around.
 */
let secondDeviceToken: string;
let versionId: string;
const questionIds: string[] = [];

beforeAll(async () => {
  world = await startWorld();
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, DEVICE_ID);
  secondDeviceToken = await loginFromDevice(world, world.actors.CONSULTANT, SECOND_DEVICE);
  await seedChecklist();
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
     VALUES ($1, 1, 50, 'sync-v1') RETURNING id`,
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

let zoneCounter = 40;

/** An open assignment, which an `EXTERNAL_5S` audit links to when one exists (R-20). */
async function assign(): Promise<void> {
  const response = await world.request('POST', `${base}/audit-assignments`, {
    token: world.actors.SUPER_ADMIN.accessToken,
    body: {
      unitId: world.unitA,
      auditorUserId: world.actors.CONSULTANT.userId,
      auditType: 'EXTERNAL_5S',
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
}

async function makeZone(): Promise<string> {
  zoneCounter += 1;
  const { rows } = await world.owner.query(
    `INSERT INTO zone (unit_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
    [world.unitA, `Z-${zoneCounter}`, `Sync zone ${zoneCounter}`],
  );
  return rows[0].id as string;
}

async function push(
  items: SyncBatchRequest['items'],
  options: { token?: string; deviceId?: string; batchId?: string } = {},
): Promise<SyncBatchResponse> {
  const response = await world.request('POST', `${base}/sync/batch`, {
    token: options.token ?? consultantToken,
    headers: { 'x-device-id': options.deviceId ?? DEVICE_ID },
    body: {
      batchId: options.batchId ?? randomUUID(),
      deviceId: options.deviceId ?? DEVICE_ID,
      appVersion: '1.4.2',
      clientTime: new Date().toISOString(),
      items,
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as SyncBatchResponse;
}

/** The outbox items a device would hold for one audit, one Zone and `answers` responses. */
function auditBatch(input: {
  auditId: string;
  auditZoneId: string;
  zoneId: string;
  answers: number;
  responseIds?: string[];
}): SyncBatchRequest['items'] {
  const now = new Date().toISOString();
  const items: SyncBatchRequest['items'] = [
    {
      outboxId: randomUUID(),
      entityType: 'audit',
      entityId: input.auditId,
      operation: 'upsert',
      payload: {
        auditType: 'EXTERNAL_5S',
        unitId: world.unitA,
        checklistVersionId: versionId,
        clientCreatedAt: now,
      },
    },
    {
      outboxId: randomUUID(),
      entityType: 'audit_zone',
      entityId: input.auditZoneId,
      operation: 'upsert',
      payload: {
        auditId: input.auditId,
        zoneId: input.zoneId,
        sequenceNo: 1,
        checklistVersionId: versionId,
      },
    },
  ];

  for (let index = 0; index < input.answers; index += 1) {
    items.push({
      outboxId: randomUUID(),
      entityType: 'question_response',
      entityId: input.responseIds?.[index] ?? randomUUID(),
      operation: 'upsert',
      payload: {
        auditZoneId: input.auditZoneId,
        checklistQuestionId: questionIds[index],
        value: index % 3 === 0 ? 'SCORE_1' : 'SCORE_2',
        answeredAt: now,
      },
    });
  }

  return items;
}

/** An audit created and started through the ordinary endpoints, selfie and all. */
async function startedAudit() {
  await assign();
  const zoneId = await makeZone();
  const auditId = randomUUID();

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

  return { auditId, auditZoneId, zoneId };
}

describe('§9.3 — per-item results', () => {
  it('applies a whole audit in one batch, in topological order', async () => {
    await assign();
    const zoneId = await makeZone();
    const auditId = randomUUID();
    const auditZoneId = randomUUID();

    // Deliberately shuffled: the responses come first in the array, and the server sorts.
    const items = auditBatch({ auditId, auditZoneId, zoneId, answers: 5 });
    const shuffled = [...items.slice(2), items[1]!, items[0]!];

    const response = await push(shuffled);

    expect(response.results).toHaveLength(7);
    expect(
      response.results.filter((r) => r.status !== 'ACCEPTED'),
      JSON.stringify(response.results, null, 2),
    ).toEqual([]);

    const detail = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    expect(detail.status).toBe(200);
    expect((detail.body as { zones: Array<{ responses: unknown[] }> }).zones[0]!.responses)
      .toHaveLength(5);
  });

  it('accepts 99 of a 100-item batch when one item is malformed', async () => {
    await assign();
    const zoneId = await makeZone();
    const auditId = randomUUID();
    const auditZoneId = randomUUID();

    // Two Zones of the same audit: the checklist has fifty questions, so a hundred-item
    // batch is one audit, two Zones and ninety-six answers rather than ninety-seven
    // answers to a fifty-question sheet.
    const secondZoneId = await makeZone();
    const secondAuditZoneId = randomUUID();

    const items = auditBatch({ auditId, auditZoneId, zoneId, answers: 48 });
    items.push({
      outboxId: randomUUID(),
      entityType: 'audit_zone',
      entityId: secondAuditZoneId,
      operation: 'upsert',
      payload: {
        auditId,
        zoneId: secondZoneId,
        sequenceNo: 2,
        checklistVersionId: versionId,
      },
    });
    for (let index = 0; index < 48; index += 1) {
      items.push({
        outboxId: randomUUID(),
        entityType: 'question_response',
        entityId: randomUUID(),
        operation: 'upsert',
        payload: {
          auditZoneId: secondAuditZoneId,
          checklistQuestionId: questionIds[index],
          value: 'SCORE_2',
          answeredAt: new Date().toISOString(),
        },
      });
    }
    expect(items).toHaveLength(99);

    // The poisoned item: a value outside the enum. §9.3's whole point is that this must
    // not cost the other ninety-nine — "that is how a field team loses a day's work".
    items.push({
      outboxId: randomUUID(),
      entityType: 'question_response',
      entityId: randomUUID(),
      operation: 'upsert',
      payload: {
        auditZoneId,
        checklistQuestionId: questionIds[49],
        value: 'SCORE_9',
        answeredAt: new Date().toISOString(),
      },
    });

    const response = await push(items);

    const accepted = response.results.filter((r) => r.status === 'ACCEPTED');
    const rejected = response.results.filter((r) => r.status === 'REJECTED');
    expect(accepted).toHaveLength(99);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.errors?.join(' ')).toMatch(/value/i);

    // And the malformed one is quarantined rather than dropped — §9.5 lists
    // VALIDATION_FAILED precisely so a client bug costs a diagnosis, not field work.
    expect(rejected[0]!.conflictId).toBeTruthy();
    const conflict = await world.request(
      'GET',
      `${base}/sync-conflicts/${rejected[0]!.conflictId}`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    expect(conflict.status).toBe(200);
    expect((conflict.body as SyncConflict).incomingPayload).toMatchObject({ value: 'SCORE_9' });

    // 0020: the refusal is kept on the row, not only in the container log. Without this a
    // Super Admin reads "Payload could not be read" over a payload that looks well formed
    // and has no way to tell which rule refused it.
    expect((conflict.body as SyncConflict).detail).toMatch(/value/i);
  });

  it('answers RETRY_AFTER_PARENT for a child whose parent is not there yet', async () => {
    const orphanZoneId = randomUUID();

    const response = await push([
      {
        outboxId: randomUUID(),
        entityType: 'question_response',
        entityId: randomUUID(),
        operation: 'upsert',
        payload: {
          auditZoneId: orphanZoneId,
          checklistQuestionId: questionIds[0],
          value: 'SCORE_2',
          answeredAt: new Date().toISOString(),
        },
      },
    ]);

    expect(response.results[0]).toMatchObject({
      status: 'RETRY_AFTER_PARENT',
      missingParent: `audit_zone:${orphanZoneId}`,
    });

    // Nothing was quarantined: a torn queue is transient, and marking it failed would
    // burn an attempt on work that will apply perfectly well next cycle.
    const conflicts = await world.request('GET', `${base}/sync-conflicts?limit=200`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    const forZone = (conflicts.body as Page<SyncConflict>).data.filter(
      (conflict) => conflict.entityId === orphanZoneId,
    );
    expect(forZone).toHaveLength(0);
  });
});

describe('§9.3 — a duplicated batch creates nothing extra', () => {
  it('returns the stored verdicts for a replayed batchId and writes no second row', async () => {
    await assign();
    const zoneId = await makeZone();
    const auditId = randomUUID();
    const auditZoneId = randomUUID();
    const batchId = randomUUID();

    const items = auditBatch({ auditId, auditZoneId, zoneId, answers: 10 });

    const first = await push(items, { batchId });
    expect(first.replayed).toBe(false);

    const second = await push(items, { batchId });
    expect(second.replayed).toBe(true);
    expect(second.results).toEqual(first.results);

    const { rows } = await world.owner.query(
      `SELECT
         (SELECT COUNT(*)::int FROM audit WHERE id = $1) AS audits,
         (SELECT COUNT(*)::int FROM audit_zone WHERE audit_id = $1) AS zones,
         (SELECT COUNT(*)::int FROM question_response WHERE audit_id = $1) AS responses,
         (SELECT COUNT(*)::int FROM device_sync_record WHERE batch_id = $2) AS batches`,
      [auditId, batchId],
    );
    expect(rows[0]).toEqual({ audits: 1, zones: 1, responses: 10, batches: 1 });
  });

  it('creates nothing extra when the same items arrive under a *different* batch id', async () => {
    await assign();
    const zoneId = await makeZone();
    const auditId = randomUUID();
    const auditZoneId = randomUUID();
    const responseIds = Array.from({ length: 6 }, () => randomUUID());

    const items = auditBatch({ auditId, auditZoneId, zoneId, answers: 6, responseIds });

    await push(items);
    // A device that lost the response and rebuilt its batch: same work, new batch id.
    const again = await push(
      items.map((item) => ({ ...item, outboxId: randomUUID() })),
    );

    expect(again.replayed).toBe(false);
    // Accepted, not refused — the *rows* are idempotent even when the batch is not.
    expect(again.results.every((r) => r.status === 'ACCEPTED' || r.status === 'DUPLICATE')).toBe(
      true,
    );

    const { rows } = await world.owner.query(
      `SELECT COUNT(*)::int AS count FROM question_response WHERE audit_id = $1`,
      [auditId],
    );
    expect(rows[0].count).toBe(6);
  });
});

describe('§9.5 Layer 1 — one device owns an audit', () => {
  it('quarantines a second device’s push with DEVICE_NOT_OWNER, payload intact', async () => {
    const { auditZoneId } = await startedAudit();

    const response = await push(
      [
        {
          outboxId: randomUUID(),
          entityType: 'question_response',
          entityId: randomUUID(),
          operation: 'upsert',
          payload: {
            auditZoneId,
            checklistQuestionId: questionIds[0],
            value: 'SCORE_1',
            remark: 'Rack B unlabelled',
            answeredAt: new Date().toISOString(),
          },
        },
      ],
      { token: secondDeviceToken, deviceId: SECOND_DEVICE },
    );

    expect(response.results[0]).toMatchObject({
      status: 'CONFLICT',
      reason: 'DEVICE_NOT_OWNER',
      resolution: 'QUARANTINED',
    });

    const conflict = await world.request(
      'GET',
      `${base}/sync-conflicts/${response.results[0]!.conflictId}`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    // The full payload, which is the single most important property of the design: the
    // second device's work is not lost, it is held.
    expect((conflict.body as SyncConflict).incomingPayload).toMatchObject({
      value: 'SCORE_1',
      remark: 'Rack B unlabelled',
    });
  });

  it('force-releases the lock so a replacement device can take over (D7)', async () => {
    const { auditId } = await startedAudit();

    const before = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    expect((before.body as Audit).owningDeviceId).toBe(DEVICE_ID);

    const released = await world.request('POST', `${base}/audits/${auditId}/release-device`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { reason: 'Phone lost on the shop floor' },
    });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect((released.body as Audit).owningDeviceId).toBeNull();
    // Nothing else moved: a release is not a cancellation.
    expect((released.body as Audit).status).toBe('IN_PROGRESS');

    const { rows } = await world.owner.query(
      `SELECT action, after FROM audit_log WHERE resource_id = $1 AND action = 'audit.device_released'`,
      [auditId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].after).toMatchObject({ reason: 'Phone lost on the shop floor' });

    // The replacement claims it — which is the whole point of the release, and would not
    // work if `start` refused an IN_PROGRESS audit whose lock is free.
    const claimed = await world.request('POST', `${base}/audits/${auditId}/start`, {
      token: secondDeviceToken,
      headers: { 'x-device-id': SECOND_DEVICE },
      body: { deviceId: SECOND_DEVICE },
    });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect((claimed.body as Audit).owningDeviceId).toBe(SECOND_DEVICE);
  });

  it('releases a PAUSED audit’s lock after the grace period, and not before', async () => {
    const { auditId } = await startedAudit();
    await world.request('POST', `${base}/audits/${auditId}/pause`, {
      token: consultantToken,
      body: { reason: 'Shift ended' },
    });

    const { DeviceReleaseWorker } = await import('../src/modules/sync/device-release.worker');
    const worker = world.app.get(DeviceReleaseWorker);

    // Freshly paused: the auditor is at lunch, and their work is still theirs.
    await worker.sweep();
    const held = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    expect((held.body as Audit).owningDeviceId).toBe(DEVICE_ID);

    // Paused two days ago: the phone is not coming back.
    await world.owner.query(
      `UPDATE audit SET paused_at = now() - interval '48 hours' WHERE id = $1`,
      [auditId],
    );
    const released = await worker.sweep();
    expect(released).toBeGreaterThanOrEqual(1);

    const after = await world.request('GET', `${base}/audits/${auditId}`, {
      token: consultantToken,
    });
    expect((after.body as Audit).owningDeviceId).toBeNull();
    expect((after.body as Audit).status).toBe('PAUSED');
  });
});

describe('§9.5 Layer 3 — the quarantine', () => {
  it('quarantines a late item for a completed audit, and accepts a byte-identical one', async () => {
    const { auditId, auditZoneId } = await startedAudit();

    // Answer all fifty and finish, through the ordinary endpoints.
    for (let index = 0; index < 50; index += 1) {
      await world.request('PUT', `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`, {
        token: consultantToken,
        body: {
          checklistQuestionId: questionIds[index],
          value: 'SCORE_2',
          answeredAt: new Date().toISOString(),
        },
      });
    }
    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token: consultantToken,
      body: {},
    });
    await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });

    const { rows } = await world.owner.query(
      `SELECT id FROM question_response WHERE audit_zone_id = $1 AND global_order = 1`,
      [auditZoneId],
    );
    const responseId = rows[0].id as string;

    // §9.5: byte-identical → DUPLICATE, accepted silently.
    const identical = await push([
      {
        outboxId: randomUUID(),
        entityType: 'question_response',
        entityId: responseId,
        operation: 'upsert',
        payload: {
          auditZoneId,
          checklistQuestionId: questionIds[0],
          value: 'SCORE_2',
          answeredAt: new Date().toISOString(),
        },
      },
    ]);
    expect(identical.results[0]!.status).toBe('DUPLICATE');

    // Different → quarantined, with both sides recorded.
    const different = await push([
      {
        outboxId: randomUUID(),
        entityType: 'question_response',
        entityId: responseId,
        operation: 'upsert',
        payload: {
          auditZoneId,
          checklistQuestionId: questionIds[0],
          value: 'SCORE_0',
          remark: 'Found worse on the second pass',
          answeredAt: new Date().toISOString(),
        },
      },
    ]);
    expect(different.results[0]).toMatchObject({
      status: 'CONFLICT',
      reason: 'AUDIT_ALREADY_COMPLETED',
    });

    const conflict = await world.request(
      'GET',
      `${base}/sync-conflicts/${different.results[0]!.conflictId}`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    const body = conflict.body as SyncConflict;
    expect(body.incomingPayload).toMatchObject({ value: 'SCORE_0' });
    expect(body.existingPayload).toMatchObject({ value: 'SCORE_2' });

    // A Super Admin applies it, and the override path writes the audit-log entry.
    const resolved = await world.request(
      'POST',
      `${base}/sync-conflicts/${body.id}/resolve`,
      {
        token: world.actors.SUPER_ADMIN.accessToken,
        body: { resolution: 'APPLY', note: 'Second pass is the correct reading' },
      },
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);

    const applied = await world.owner.query(
      `SELECT value FROM question_response WHERE id = $1`,
      [responseId],
    );
    expect(applied.rows[0].value).toBe('SCORE_0');

    const logged = await world.owner.query(
      `SELECT COUNT(*)::int AS count FROM audit_log
       WHERE resource_id = $1 AND action = 'audit.changed_after_completion'`,
      [auditId],
    );
    expect(logged.rows[0].count).toBeGreaterThanOrEqual(1);
  });

  it('keeps the payload when a conflict is discarded', async () => {
    const conflicts = await world.request('GET', `${base}/sync-conflicts?limit=200`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    const unresolved = (conflicts.body as Page<SyncConflict>).data[0];
    expect(unresolved).toBeTruthy();

    const resolved = await world.request(
      'POST',
      `${base}/sync-conflicts/${unresolved!.id}/resolve`,
      {
        token: world.actors.SUPER_ADMIN.accessToken,
        body: { resolution: 'DISCARD', note: 'Superseded by a later answer' },
      },
    );
    expect(resolved.status).toBe(200);

    // Discarding is a decision about what to act on, never about what to retain.
    const { rows } = await world.owner.query(
      `SELECT incoming_payload, resolution FROM sync_conflict WHERE id = $1`,
      [unresolved!.id],
    );
    expect(rows[0].resolution).toBe('DISCARD');
    expect(rows[0].incoming_payload).toEqual(unresolved!.incomingPayload);
  });

  it('refuses to resolve the same conflict twice', async () => {
    const conflicts = await world.request('GET', `${base}/sync-conflicts?resolved=true&limit=5`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    const already = (conflicts.body as Page<SyncConflict>).data[0];
    expect(already).toBeTruthy();

    const again = await world.request('POST', `${base}/sync-conflicts/${already!.id}/resolve`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { resolution: 'DISCARD', note: 'Trying again' },
    });
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe('CONFLICT_ALREADY_RESOLVED');
  });

  it('shows a Consultant none of the queue, even their own payloads', async () => {
    const response = await world.request('GET', `${base}/sync-conflicts`, {
      token: consultantToken,
    });
    // PART 6.3 grants `sync_conflict:read` to SUPER_ADMIN alone.
    expect(response.status).toBe(403);
  });
});

describe('§9.5 — clock skew', () => {
  it('returns serverTime on every batch, so a skewed device can normalise', async () => {
    await assign();
    const zoneId = await makeZone();
    const auditId = randomUUID();
    const auditZoneId = randomUUID();

    const before = Date.now();
    const response = await push(auditBatch({ auditId, auditZoneId, zoneId, answers: 1 }));
    const after = Date.now();

    const serverTime = Date.parse(response.serverTime);
    expect(serverTime).toBeGreaterThanOrEqual(before - 1000);
    expect(serverTime).toBeLessThanOrEqual(after + 1000);
  });

  it('assigns completion times itself, whatever the device’s clock says (§9.5)', async () => {
    const { auditId, auditZoneId } = await startedAudit();

    for (let index = 0; index < 50; index += 1) {
      await world.request('PUT', `${base}/audit-zones/${auditZoneId}/responses/${randomUUID()}`, {
        token: consultantToken,
        body: {
          checklistQuestionId: questionIds[index],
          value: 'SCORE_2',
          // A device whose clock is a year fast.
          answeredAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        },
      });
    }

    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token: consultantToken,
      body: {},
    });
    const completed = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });

    // "Business timestamps (`completed_at`) are **server-assigned**; device clocks order
    // events only." A year-fast phone must not date an audit into next year.
    const completedAt = Date.parse((completed.body as Audit).completedAt!);
    expect(completedAt).toBeLessThan(Date.now() + 60_000);
  });
});

describe('GET /sync/status (§8.11)', () => {
  it('reports the locks this device holds and the work awaiting attention', async () => {
    const { auditId } = await startedAudit();

    const response = await world.request('GET', `${base}/sync/status`, {
      token: consultantToken,
      headers: { 'x-device-id': DEVICE_ID },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const status = response.body as SyncStatus;
    expect(status.deviceId).toBe(DEVICE_ID);
    expect(status.ownedAudits.map((audit) => audit.auditId)).toContain(auditId);
    expect(status.batchesLast24h).toBeGreaterThan(0);
    expect(status.lastBatchAt).not.toBeNull();
    expect(status.unresolvedConflictCount).toBeGreaterThanOrEqual(0);
  });

  it('counts evidence whose object never arrived — §9.4’s orphan_metadata', async () => {
    const { auditId, auditZoneId } = await startedAudit();

    await captureEvidence(world, {
      token: consultantToken,
      evidenceId: randomUUID(),
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      deviceId: DEVICE_ID,
      skipCommit: true,
    });

    const response = await world.request('GET', `${base}/sync/status`, {
      token: consultantToken,
      headers: { 'x-device-id': DEVICE_ID },
    });
    expect((response.body as SyncStatus).awaitingUploadCount).toBeGreaterThanOrEqual(1);
  });
});

describe('devices (§8.11)', () => {
  it('registers a device idempotently and lists it', async () => {
    const deviceId = randomUUID();

    const first = await world.request('POST', `${base}/devices/register`, {
      token: consultantToken,
      body: {
        deviceId,
        platform: 'android',
        model: 'Pixel 8',
        osVersion: '15',
        appVersion: '1.4.2',
        pushToken: 'fcm-token-abc',
      },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const second = await world.request('POST', `${base}/devices/register`, {
      token: consultantToken,
      body: { deviceId, platform: 'android', model: 'Pixel 8', appVersion: '1.4.3' },
    });
    expect(second.status).toBe(200);
    expect((second.body as Device).appVersion).toBe('1.4.3');

    const listed = await world.request('GET', `${base}/devices`, { token: consultantToken });
    expect((listed.body as Page<Device>).data.map((d) => d.id)).toContain(deviceId);
  });

  it('refuses to adopt a device registered to another user, without saying it exists', async () => {
    const deviceId = randomUUID();
    await world.request('POST', `${base}/devices/register`, {
      token: consultantToken,
      body: { deviceId, platform: 'android' },
    });

    const stolen = await world.request('POST', `${base}/devices/register`, {
      token: world.actors.ZONE_LEADER.accessToken,
      body: { deviceId, platform: 'android' },
    });
    // 404 rather than 409: AZ-3 says an out-of-scope read must not reveal that the row
    // exists, and a device id is client-generated — a conflict here would make the route
    // an oracle for which ids are taken.
    expect(stolen.status).toBe(404);

    // And the original owner still holds it, untouched.
    const mine = await world.request('GET', `${base}/devices/${deviceId}`, {
      token: consultantToken,
    });
    expect(mine.status).toBe(200);
    expect((mine.body as Device).userId).toBe(world.actors.CONSULTANT.userId);
  });

  it('revokes a device and its sessions, and refuses to re-register it', async () => {
    const deviceId = randomUUID();
    await world.request('POST', `${base}/devices/register`, {
      token: consultantToken,
      body: { deviceId, platform: 'android' },
    });

    const revoked = await world.request('POST', `${base}/devices/${deviceId}/revoke`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect((revoked.body as Device).revokedAt).not.toBeNull();

    // Re-registering must not un-revoke it, or revocation would be one restart away from
    // meaningless.
    const again = await world.request('POST', `${base}/devices/register`, {
      token: consultantToken,
      body: { deviceId, platform: 'android' },
    });
    expect(again.status).toBe(403);
    expect((again.body as { code: string }).code).toBe('DEVICE_REVOKED');
  });

  it('shows a Consultant only their own devices', async () => {
    const listed = await world.request('GET', `${base}/devices?limit=200`, {
      token: consultantToken,
    });
    const mine = (listed.body as Page<Device>).data;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((device) => device.userId === world.actors.CONSULTANT.userId)).toBe(true);
  });
});
