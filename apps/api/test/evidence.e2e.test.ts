import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  type Audit,
  type Evidence,
  type EvidenceViewUrl,
  type Page,
  type UploadIntentResponse,
} from '@audit5s/contracts';
import { S_SECTION_ORDER } from '@audit5s/domain';
import {
  TINY_JPEG,
  captureEvidence,
  loginFromDevice,
  sha256Hex,
  startWorld,
  stopWorld,
  type TestWorld,
} from './harness';

/**
 * The evidence surface (§8.7), the two-phase media commit (§9.4) and the upload controls
 * of §12.8 — end to end, through the real endpoints and the real presigned URLs.
 *
 * Every photograph in this file goes intent → PUT → commit. Nothing inserts a row behind
 * the API, because the protocol *is* what is under test: §9.6 makes replaying half of it
 * the crash-recovery path, and a suite that skipped the presigned PUT would prove nothing
 * about the path a device actually takes.
 */

let world: TestWorld;
const base = API_BASE_PATH;

const DEVICE_ID = '01930000-0000-7000-8000-0000000ed001';
const OTHER_DEVICE = '01930000-0000-7000-8000-0000000ed002';

let consultantToken: string;
let versionId: string;
const questionIds: string[] = [];

beforeAll(async () => {
  world = await startWorld();
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, DEVICE_ID);
  await seedChecklist();
}, 180_000);

afterAll(async () => {
  await stopWorld(world);
});

async function seedChecklist(): Promise<void> {
  const { rows: template } = await world.owner.query(
    `INSERT INTO checklist_template (code, name) VALUES ('SHOP_FLOOR', 'Shop Floor') RETURNING id`,
  );
  // A real 5×10 version: CQ-1 is a database constraint, so a four-question fixture is not
  // a smaller version of the truth, it is a shape the schema refuses.
  const { rows: version } = await world.owner.query(
    `INSERT INTO checklist_version (template_id, version_number, total_questions, content_hash)
     VALUES ($1, 1, 50, 'evidence-v1') RETURNING id`,
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

let zoneCounter = 10;

/** An IN_PROGRESS audit with one Zone, with its selfie already captured. */
async function runningAudit(options: { auditType?: 'EXTERNAL_5S' | 'WALK_BY' } = {}) {
  zoneCounter += 1;
  const { rows } = await world.owner.query(
    `INSERT INTO zone (unit_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
    [world.unitA, `Z-${zoneCounter}`, `Evidence zone ${zoneCounter}`],
  );
  const zoneId = rows[0].id as string;

  const auditType = options.auditType ?? 'EXTERNAL_5S';
  const auditId = randomUUID();

  if (auditType === 'EXTERNAL_5S') {
    await world.request('POST', `${base}/audit-assignments`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        unitId: world.unitA,
        auditorUserId: world.actors.CONSULTANT.userId,
        auditType: 'EXTERNAL_5S',
      },
    });
  }

  const created = await world.request('POST', `${base}/audits`, {
    token: consultantToken,
    body: {
      id: auditId,
      auditType,
      unitId: world.unitA,
      ...(auditType === 'EXTERNAL_5S' ? { checklistVersionId: versionId } : {}),
      deviceId: DEVICE_ID,
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  // No selfie yet, so §7.1 leaves it at ASSIGNED.
  expect((created.body as Audit).status).toBe('ASSIGNED');

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

  const auditZoneId = randomUUID();
  const zone = await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
    token: consultantToken,
    body: {
      zoneId,
      sequenceNo: 1,
      ...(auditType === 'EXTERNAL_5S' ? { checklistVersionId: versionId } : {}),
    },
  });
  expect(zone.status, JSON.stringify(zone.body)).toBe(200);

  return { auditId, auditZoneId, zoneId };
}

async function answer(auditZoneId: string, index: number, value: string): Promise<string> {
  const responseId = randomUUID();
  const response = await world.request(
    'PUT',
    `${base}/audit-zones/${auditZoneId}/responses/${responseId}`,
    {
      token: consultantToken,
      body: {
        checklistQuestionId: questionIds[index],
        value,
        answeredAt: new Date().toISOString(),
      },
    },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body as { id: string }).id;
}

describe('§7.1 — the selfie guard', () => {
  it('holds an audit at ASSIGNED until a selfie exists, then lets it start', async () => {
    const auditId = randomUUID();
    await world.request('POST', `${base}/audit-assignments`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        unitId: world.unitA,
        auditorUserId: world.actors.CONSULTANT.userId,
        auditType: 'EXTERNAL_5S',
      },
    });

    const created = await world.request('POST', `${base}/audits`, {
      token: consultantToken,
      body: {
        id: auditId,
        auditType: 'EXTERNAL_5S',
        unitId: world.unitA,
        checklistVersionId: versionId,
        deviceId: DEVICE_ID,
      },
    });
    expect((created.body as Audit).status).toBe('ASSIGNED');

    // Without a selfie the start is refused, and the refusal names the guard.
    const tooEarly = await world.request('POST', `${base}/audits/${auditId}/start`, {
      token: consultantToken,
      body: { deviceId: DEVICE_ID },
    });
    expect(tooEarly.status).toBe(409);
    expect((tooEarly.body as { detail: string }).detail).toContain('selfie_captured');

    const selfieId = randomUUID();
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId: selfieId,
      auditId,
      kind: 'AUDITOR_SELFIE',
      deviceId: DEVICE_ID,
    });

    const started = await world.request('POST', `${base}/audits/${auditId}/start`, {
      token: consultantToken,
      body: { deviceId: DEVICE_ID },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    // Committing the selfie pointed the audit at it, so the report can find it later.
    expect((started.body as Audit).selfieEvidenceId).toBe(selfieId);
  });

  it('refuses a gallery image as a selfie (§12.10)', async () => {
    const auditId = randomUUID();
    await world.request('POST', `${base}/audits`, {
      token: consultantToken,
      body: {
        id: auditId,
        // A walk-by rather than a cross audit: R-8a gives `audit:create_cross` to a Zone
        // Leader only, and this test is about the selfie, not about who may open what.
        auditType: 'WALK_BY',
        unitId: world.unitA,
        deviceId: DEVICE_ID,
      },
    });

    const bytes = TINY_JPEG;
    const intent = await world.request('POST', `${base}/evidence/upload-intent`, {
      token: consultantToken,
      body: {
        id: randomUUID(),
        kind: 'AUDITOR_SELFIE',
        auditId,
        contentType: 'image/jpeg',
        byteSize: bytes.byteLength,
        checksumSha256: sha256Hex(bytes),
        capturedAt: new Date().toISOString(),
        // The capture component sets this; a gallery pick would not.
        isLiveCapture: false,
      },
    });
    expect(intent.status).toBe(201);

    const started = await world.request('POST', `${base}/audits/${auditId}/start`, {
      token: consultantToken,
      body: { deviceId: DEVICE_ID },
    });
    expect(started.status).toBe(409);
    expect((started.body as { detail: string }).detail).toContain('selfie_captured');
  });
});

describe('§9.4 — the two-phase media commit', () => {
  it('mints a presigned PUT, accepts the bytes, and confirms them', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const evidenceId = randomUUID();

    const captured = await captureEvidence(world, {
      token: consultantToken,
      evidenceId,
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      classification: 'GOOD',
      deviceId: DEVICE_ID,
    });

    // §5.6's key convention: the Unit comes first, so a per-Unit export is a prefix scan.
    expect(captured.objectKey).toMatch(
      new RegExp(`^evidence/${world.unitA}/${auditId}/${auditZoneId}/${evidenceId}\\.jpg$`),
    );

    const stored = await world.request('GET', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
    });
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({
      syncState: 'SYNCED',
      classification: 'GOOD',
      isLiveCapture: true,
      byteSize: TINY_JPEG.byteLength,
      checksumSha256: captured.checksum,
    });
    expect((stored.body as Evidence).uploadedAt).not.toBeNull();
  });

  it('returns the same intent for the same id, so a retry cannot mint a second key', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const evidenceId = randomUUID();
    const bytes = TINY_JPEG;

    const body = {
      id: evidenceId,
      kind: 'WALK_BY_PHOTO',
      auditId,
      auditZoneId,
      contentType: 'image/jpeg',
      byteSize: bytes.byteLength,
      checksumSha256: sha256Hex(bytes),
      capturedAt: new Date().toISOString(),
      isLiveCapture: true,
    };

    const first = await world.request('POST', `${base}/evidence/upload-intent`, {
      token: consultantToken,
      body,
    });
    const second = await world.request('POST', `${base}/evidence/upload-intent`, {
      token: consultantToken,
      body,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((second.body as UploadIntentResponse).objectKey).toBe(
      (first.body as UploadIntentResponse).objectKey,
    );
    expect((second.body as UploadIntentResponse).alreadyExists).toBe(true);

    const { rows } = await world.owner.query(
      `SELECT COUNT(*)::int AS count FROM evidence WHERE audit_id = $1 AND kind = 'WALK_BY_PHOTO'`,
      [auditId],
    );
    expect(rows[0].count).toBe(1);
  });

  it('refuses a commit before the object has arrived (§9.4 orphan_metadata)', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const evidenceId = randomUUID();
    const bytes = TINY_JPEG;

    await world.request('POST', `${base}/evidence/upload-intent`, {
      token: consultantToken,
      body: {
        id: evidenceId,
        kind: 'WALK_BY_PHOTO',
        auditId,
        auditZoneId,
        contentType: 'image/jpeg',
        byteSize: bytes.byteLength,
        checksumSha256: sha256Hex(bytes),
        capturedAt: new Date().toISOString(),
        isLiveCapture: true,
      },
    });

    const commit = await world.request('POST', `${base}/evidence/${evidenceId}/commit`, {
      token: consultantToken,
      body: { checksumSha256: sha256Hex(bytes) },
    });
    expect(commit.status).toBe(409);
    expect((commit.body as { code: string }).code).toBe('EVIDENCE_NOT_UPLOADED');
  });

  it('is idempotent on replay — §9.6’s "killed between the PUT and the commit"', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const evidenceId = randomUUID();

    const captured = await captureEvidence(world, {
      token: consultantToken,
      evidenceId,
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      deviceId: DEVICE_ID,
    });

    const first = await world.request('GET', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
    });

    // The device did not hear the answer and commits again. This is the recovery path,
    // not an error, and it must not produce a second row or a different one.
    const replay = await world.request('POST', `${base}/evidence/${evidenceId}/commit`, {
      token: consultantToken,
      body: { checksumSha256: captured.checksum },
    });
    expect(replay.status).toBe(200);
    expect((replay.body as Evidence).uploadedAt).toBe((first.body as Evidence).uploadedAt);
  });

  it('refuses a commit whose checksum differs from the intent', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const evidenceId = randomUUID();

    await captureEvidence(world, {
      token: consultantToken,
      evidenceId,
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      deviceId: DEVICE_ID,
      skipCommit: true,
    });

    const commit = await world.request('POST', `${base}/evidence/${evidenceId}/commit`, {
      token: consultantToken,
      body: { checksumSha256: 'f'.repeat(64) },
    });
    expect(commit.status).toBe(409);
    expect((commit.body as { code: string }).code).toBe('CHECKSUM_MISMATCH');
  });

  it('refuses bytes that are not the image type they claim to be (§12.8)', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const evidenceId = randomUUID();

    // A ZIP renamed to .jpg. The presigned policy accepted the *claim*; the magic-byte
    // sniff at commit is what catches what was actually sent.
    const notAnImage = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

    await expect(
      captureEvidence(world, {
        token: consultantToken,
        evidenceId,
        auditId,
        auditZoneId,
        kind: 'WALK_BY_PHOTO',
        deviceId: DEVICE_ID,
        bytes: notAnImage,
      }),
    ).rejects.toThrow(/UNSUPPORTED_MEDIA_TYPE/);
  });
});

describe('DECISIONS.md R-9 — the signed storage route', () => {
  it('refuses an unsigned PUT', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const evidenceId = randomUUID();
    const bytes = TINY_JPEG;

    const intent = await world.request('POST', `${base}/evidence/upload-intent`, {
      token: consultantToken,
      body: {
        id: evidenceId,
        kind: 'WALK_BY_PHOTO',
        auditId,
        auditZoneId,
        contentType: 'image/jpeg',
        byteSize: bytes.byteLength,
        checksumSha256: sha256Hex(bytes),
        capturedAt: new Date().toISOString(),
        isLiveCapture: true,
      },
    });
    const { uploadUrl } = intent.body as UploadIntentResponse;
    const path = uploadUrl.replace(/^https?:\/\/[^/]+/, '');
    const unsigned = path.split('?')[0]!;

    const response = await world.app.inject({
      method: 'PUT',
      url: unsigned,
      headers: { 'content-type': 'image/jpeg' },
      payload: bytes,
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('MISSING_SIGNATURE');
  });

  it('refuses a tampered signature', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const evidenceId = randomUUID();
    const bytes = TINY_JPEG;

    const intent = await world.request('POST', `${base}/evidence/upload-intent`, {
      token: consultantToken,
      body: {
        id: evidenceId,
        kind: 'WALK_BY_PHOTO',
        auditId,
        auditZoneId,
        contentType: 'image/jpeg',
        byteSize: bytes.byteLength,
        checksumSha256: sha256Hex(bytes),
        capturedAt: new Date().toISOString(),
        isLiveCapture: true,
      },
    });
    const path = (intent.body as UploadIntentResponse).uploadUrl.replace(
      /^https?:\/\/[^/]+/,
      '',
    );

    const response = await world.app.inject({
      method: 'PUT',
      url: path.replace(/sig=[0-9a-f]+/, `sig=${'0'.repeat(64)}`),
      headers: { 'content-type': 'image/jpeg' },
      payload: bytes,
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('BAD_SIGNATURE');
  });

  it('refuses a body of a different size from the one the URL was signed for', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const evidenceId = randomUUID();
    const bytes = TINY_JPEG;

    const intent = await world.request('POST', `${base}/evidence/upload-intent`, {
      token: consultantToken,
      body: {
        id: evidenceId,
        kind: 'WALK_BY_PHOTO',
        auditId,
        auditZoneId,
        contentType: 'image/jpeg',
        byteSize: bytes.byteLength,
        checksumSha256: sha256Hex(bytes),
        capturedAt: new Date().toISOString(),
        isLiveCapture: true,
      },
    });

    // The same constraint an S3 policy's ContentLength imposes: signed for a small photo,
    // a large one is refused at the edge rather than after it has been stored.
    const response = await world.app.inject({
      method: 'PUT',
      url: (intent.body as UploadIntentResponse).uploadUrl.replace(/^https?:\/\/[^/]+/, ''),
      headers: { 'content-type': 'image/jpeg' },
      payload: Buffer.concat([bytes, Buffer.alloc(1024)]),
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('SIZE_MISMATCH');
  });

  it('mints a read URL that works, and expires inside five minutes (§12.6)', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const evidenceId = randomUUID();

    await captureEvidence(world, {
      token: consultantToken,
      evidenceId,
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      deviceId: DEVICE_ID,
    });

    const view = await world.request('GET', `${base}/evidence/${evidenceId}/view-url`, {
      token: consultantToken,
    });
    expect(view.status).toBe(200);

    const url = view.body as EvidenceViewUrl;
    expect(url.expiresIn).toBeLessThanOrEqual(300);

    const fetched = await world.app.inject({
      method: 'GET',
      url: url.url.replace(/^https?:\/\/[^/]+/, ''),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/jpeg');
    expect(fetched.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(fetched.rawPayload.equals(TINY_JPEG)).toBe(true);
  });

  it('refuses a read URL to a Consultant who does not own the audit — before minting it', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const evidenceId = randomUUID();
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId,
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      deviceId: DEVICE_ID,
    });

    // A Zone Leader of another Unit. §12.6 puts the scope check *before* the mint, so
    // there is no window in which a working link is produced on the way to a refusal.
    const view = await world.request('GET', `${base}/evidence/${evidenceId}/view-url`, {
      token: world.outOfScopeActor.accessToken,
    });
    expect(view.status).toBe(404);
  });
});

describe('invariant E-1 — classification is derived, never client-asserted', () => {
  it('classifies question evidence from the linked response', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const responseId = await answer(auditZoneId, 0, 'SCORE_2');

    const good = randomUUID();
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId: good,
      auditId,
      auditZoneId,
      kind: 'QUESTION_EVIDENCE',
      questionResponseId: responseId,
      // The client lies. The server overwrites it.
      classification: 'NONCONFORMITY',
      deviceId: DEVICE_ID,
    });

    const stored = await world.request('GET', `${base}/evidence/${good}`, {
      token: consultantToken,
    });
    expect((stored.body as Evidence).classification).toBe('GOOD');
    expect((stored.body as Evidence).scoreAtCapture).toBe('SCORE_2');
  });

  it('honours the auditor’s choice on a walk-by photo, where there is no score', async () => {
    const { auditId, auditZoneId } = await runningAudit({ auditType: 'WALK_BY' });
    const evidenceId = randomUUID();

    await captureEvidence(world, {
      token: consultantToken,
      evidenceId,
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      classification: 'NONCONFORMITY',
      deviceId: DEVICE_ID,
    });

    const stored = await world.request('GET', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
    });
    expect((stored.body as Evidence).classification).toBe('NONCONFORMITY');
  });
});

describe('invariant E-2 — a changed answer re-files its photographs', () => {
  it('flips GOOD → NONCONFORMITY when the response changes 2 → 0', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const responseId = await answer(auditZoneId, 0, 'SCORE_2');

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

    const before = await world.request('GET', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
    });
    expect((before.body as Evidence).classification).toBe('GOOD');

    // The auditor looks again and marks it down.
    await world.request('PUT', `${base}/audit-zones/${auditZoneId}/responses/${responseId}`, {
      token: consultantToken,
      body: {
        checklistQuestionId: questionIds[0],
        value: 'SCORE_0',
        answeredAt: new Date().toISOString(),
      },
    });

    const after = await world.request('GET', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
    });
    expect((after.body as Evidence).classification).toBe('NONCONFORMITY');
    expect((after.body as Evidence).scoreAtCapture).toBe('SCORE_0');
  });

  it('takes the summary flag off a photo that becomes NEUTRAL (E-3)', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const responseId = await answer(auditZoneId, 1, 'SCORE_2');

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

    const flagged = await world.request('PATCH', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
      body: { isSummaryFlagged: true },
    });
    expect(flagged.status).toBe(200);

    // NA makes it NEUTRAL, and E-3 forbids a flagged NEUTRAL. The flag comes off in the
    // same statement rather than the CHECK refusing the auditor's edit.
    await world.request('PUT', `${base}/audit-zones/${auditZoneId}/responses/${responseId}`, {
      token: consultantToken,
      body: {
        checklistQuestionId: questionIds[1],
        value: 'NA',
        answeredAt: new Date().toISOString(),
      },
    });

    const after = await world.request('GET', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
    });
    expect((after.body as Evidence).classification).toBe('NEUTRAL');
    expect((after.body as Evidence).isSummaryFlagged).toBe(false);
  });
});

describe('§5.6 — one flagged GOOD and one flagged NONCONFORMITY per Zone', () => {
  it('refuses the second with 409 SUMMARY_FLAG_TAKEN', async () => {
    const { auditId, auditZoneId } = await runningAudit({ auditType: 'WALK_BY' });

    const first = randomUUID();
    const second = randomUUID();
    for (const evidenceId of [first, second]) {
      await captureEvidence(world, {
        token: consultantToken,
        evidenceId,
        auditId,
        auditZoneId,
        kind: 'WALK_BY_PHOTO',
        classification: 'GOOD',
        deviceId: DEVICE_ID,
      });
    }

    const flagFirst = await world.request('PATCH', `${base}/evidence/${first}`, {
      token: consultantToken,
      body: { isSummaryFlagged: true },
    });
    expect(flagFirst.status).toBe(200);

    const flagSecond = await world.request('PATCH', `${base}/evidence/${second}`, {
      token: consultantToken,
      body: { isSummaryFlagged: true },
    });
    expect(flagSecond.status).toBe(409);
    expect((flagSecond.body as { code: string }).code).toBe('SUMMARY_FLAG_TAKEN');
  });

  it('holds under a concurrent race, because the index is the enforcement', async () => {
    // §5.6 is explicit about why the two partial unique indexes are in the database
    // rather than in a service: "enforcing this in application logic means a duplicated
    // sync request — which is the normal case on a weak connection, not an edge case —
    // can produce two flagged photos, and the summary report then has to pick one
    // arbitrarily."
    //
    // `EvidenceService.patch` therefore does **not** pre-check; it catches the unique
    // violation. This test is what proves the difference: both requests are in flight at
    // once, so a `SELECT`-then-`UPDATE` would let both pass their own check. Exactly one
    // may win.
    const { auditId, auditZoneId } = await runningAudit({ auditType: 'WALK_BY' });

    const photos = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const evidenceId of photos) {
      await captureEvidence(world, {
        token: consultantToken,
        evidenceId,
        auditId,
        auditZoneId,
        kind: 'WALK_BY_PHOTO',
        classification: 'NONCONFORMITY',
        deviceId: DEVICE_ID,
      });
    }

    // Four at once, not awaited in turn. Four rather than two so a lucky interleaving
    // cannot pass by accident.
    const outcomes = await Promise.all(
      photos.map((evidenceId) =>
        world.request('PATCH', `${base}/evidence/${evidenceId}`, {
          token: consultantToken,
          body: { isSummaryFlagged: true },
        }),
      ),
    );

    const accepted = outcomes.filter((outcome) => outcome.status === 200);
    const refused = outcomes.filter((outcome) => outcome.status === 409);

    expect(
      accepted.length,
      `statuses: ${JSON.stringify(outcomes.map((outcome) => outcome.status))}`,
    ).toBe(1);
    expect(refused).toHaveLength(3);
    for (const outcome of refused) {
      // Named, not a generic conflict: the device unflags the other photo and retries.
      expect((outcome.body as { code: string }).code).toBe('SUMMARY_FLAG_TAKEN');
    }

    // And the database agrees with the verdicts it issued.
    const { rows } = await world.owner.query(
      `SELECT COUNT(*)::int AS count FROM evidence
        WHERE audit_zone_id = $1 AND is_summary_flagged AND deleted_at IS NULL`,
      [auditZoneId],
    );
    expect(rows[0].count).toBe(1);
  });

  it('allows one of each classification in the same Zone', async () => {
    const { auditId, auditZoneId } = await runningAudit({ auditType: 'WALK_BY' });

    const good = randomUUID();
    const bad = randomUUID();
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId: good,
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      classification: 'GOOD',
      deviceId: DEVICE_ID,
    });
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId: bad,
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      classification: 'NONCONFORMITY',
      deviceId: DEVICE_ID,
    });

    for (const evidenceId of [good, bad]) {
      const flagged = await world.request('PATCH', `${base}/evidence/${evidenceId}`, {
        token: consultantToken,
        body: { isSummaryFlagged: true },
      });
      expect(flagged.status, JSON.stringify(flagged.body)).toBe(200);
    }
  });

  it('refuses to flag a NEUTRAL photo (E-3)', async () => {
    const { auditId, auditZoneId } = await runningAudit({ auditType: 'WALK_BY' });
    const evidenceId = randomUUID();
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId,
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      deviceId: DEVICE_ID,
    });

    const flagged = await world.request('PATCH', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
      body: { isSummaryFlagged: true },
    });
    expect(flagged.status).toBe(409);
  });
});

describe('invariant E-4 — deletion is soft, and only before completion', () => {
  it('soft-deletes before completion and hides it from the Zone gallery', async () => {
    const { auditId, auditZoneId } = await runningAudit({ auditType: 'WALK_BY' });
    const keep = randomUUID();
    const remove = randomUUID();

    for (const evidenceId of [keep, remove]) {
      await captureEvidence(world, {
        token: consultantToken,
        evidenceId,
        auditId,
        auditZoneId,
        kind: 'WALK_BY_PHOTO',
        deviceId: DEVICE_ID,
      });
    }

    const deleted = await world.request('DELETE', `${base}/evidence/${remove}`, {
      token: consultantToken,
    });
    expect(deleted.status).toBe(200);
    expect((deleted.body as Evidence).deletedAt).not.toBeNull();

    const gallery = await world.request('GET', `${base}/audit-zones/${auditZoneId}/evidence`, {
      token: consultantToken,
    });
    expect((gallery.body as Page<Evidence>).data.map((item) => item.id)).toEqual([keep]);

    // The row survives — nothing is hard-deleted (D8).
    const withDeleted = await world.request(
      'GET',
      `${base}/audit-zones/${auditZoneId}/evidence?includeDeleted=true`,
      { token: consultantToken },
    );
    expect((withDeleted.body as Page<Evidence>).data).toHaveLength(2);
  });

  it('refuses a delete once the audit is completed', async () => {
    const { auditId, auditZoneId } = await runningAudit({ auditType: 'WALK_BY' });
    const evidenceId = randomUUID();
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId,
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      deviceId: DEVICE_ID,
    });

    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token: consultantToken,
      body: {},
    });
    await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });

    const deleted = await world.request('DELETE', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
    });
    expect(deleted.status).toBe(409);
    expect((deleted.body as { code: string }).code).toBe('AUDIT_ALREADY_COMPLETED');
  });
});

describe('§7.2 — a walk-by Zone needs a photograph', () => {
  it('refuses to finish a walk-by Zone with no evidence', async () => {
    const { auditId, auditZoneId } = await runningAudit({ auditType: 'WALK_BY' });

    const finished = await world.request(
      'POST',
      `${base}/audits/${auditId}/zones/${auditZoneId}/complete`,
      { token: consultantToken, body: {} },
    );
    expect(finished.status).toBe(409);
    expect((finished.body as { code: string }).code).toBe('EVIDENCE_REQUIRED');
  });

  it('finishes it once one photograph exists', async () => {
    const { auditId, auditZoneId } = await runningAudit({ auditType: 'WALK_BY' });
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId: randomUUID(),
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      deviceId: DEVICE_ID,
    });

    const finished = await world.request(
      'POST',
      `${base}/audits/${auditId}/zones/${auditZoneId}/complete`,
      { token: consultantToken, body: {} },
    );
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
  });

  it('does not let a photograph substitute for the answers in a scored Zone', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    await answer(auditZoneId, 0, 'SCORE_2');
    await captureEvidence(world, {
      token: consultantToken,
      evidenceId: randomUUID(),
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      deviceId: DEVICE_ID,
    });

    // One of fifty questions answered. The photo is irrelevant to this guard, and the
    // refusal names the rule that actually applies.
    const finished = await world.request(
      'POST',
      `${base}/audits/${auditId}/zones/${auditZoneId}/complete`,
      { token: consultantToken, body: {} },
    );
    expect(finished.status).toBe(409);
    expect((finished.body as { detail: string }).detail).toContain('all_questions_answered');
  });
});

describe('the device lock reaches evidence too (D7)', () => {
  it('refuses an upload intent from a device that does not own the audit', async () => {
    const { auditId, auditZoneId } = await runningAudit();
    const otherToken = await loginFromDevice(world, world.actors.CONSULTANT, OTHER_DEVICE);
    const bytes = TINY_JPEG;

    const intent = await world.request('POST', `${base}/evidence/upload-intent`, {
      token: otherToken,
      body: {
        id: randomUUID(),
        kind: 'WALK_BY_PHOTO',
        auditId,
        auditZoneId,
        contentType: 'image/jpeg',
        byteSize: bytes.byteLength,
        checksumSha256: sha256Hex(bytes),
        capturedAt: new Date().toISOString(),
        isLiveCapture: true,
      },
    });
    expect(intent.status).toBe(409);
    expect((intent.body as { code: string }).code).toBe('DEVICE_NOT_OWNER');

    // Restore the fixture token for the suites that follow.
    consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, DEVICE_ID);
  });
});
