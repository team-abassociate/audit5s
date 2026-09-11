import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocalZone,
  createLocalAudit,
  getLocalAuditZone,
  listOutbox,
  saveLocalResponse,
} from './audit.repository';
import {
  captureLocalEvidence,
  deleteLocalEvidence,
  getLocalEvidence,
  hasLocalSelfie,
  listLocalEvidenceForZone,
  markEvidenceIntentIssued,
  markEvidenceSynced,
  pendingPhotoCount,
  queueEvidenceCommit,
  reclassifyLocalEvidence,
  responseIdFor,
  setLocalSummaryFlag,
  zoneHasLocalEvidence,
} from './evidence.repository';
import { replaceCatalogue } from './catalogue.repository';
import { createLocalDatabase, migrateLocalDatabase, type LocalDatabase } from './local-database';
import { LOCAL_SCHEMA_VERSION } from './migrations';
import { createNodeExecutor } from './node-executor';
import { FIXTURE_UNIT as UNIT, FIXTURE_ZONE_A as ZONE_A, catalogue } from './test-fixtures';

/**
 * The device's evidence store, against **real SQLite**.
 *
 * The same reasoning as `audit.repository.test.ts`: these are the statements Drizzle issues
 * on a phone, executed by an actual SQLite. A photograph is the one piece of audit data
 * that cannot be re-derived from anything — an answer can be asked again, a Zone can be
 * re-walked, but the state of a rack at 09:14 on a Tuesday is gone — so the queries that
 * hold it get the same treatment as the ones that hold the answers.
 */

let executor: ReturnType<typeof createNodeExecutor>;
let database: LocalDatabase;

beforeEach(async () => {
  executor = createNodeExecutor();
  await migrateLocalDatabase(executor);
  database = createLocalDatabase(executor);
  await replaceCatalogue(database, catalogue());
});

afterEach(() => {
  executor.close();
});



/** An audit with one Zone, ready for photographs. */
async function auditWithZone() {
  const auditId = await createLocalAudit(database, {
    unitId: UNIT,
    auditType: 'WALK_BY',
    checklistVersionId: null,
  });
  const auditZoneId = await addLocalZone(database, {
    auditId,
    zoneId: ZONE_A,
    sequenceNo: 1,
    checklistVersionId: null,
  });
  return { auditId, auditZoneId };
}

const PHOTO = {
  localFileUri: 'file:///data/audit5s/photo-1.jpg',
  byteSize: 184_320,
  width: 1920,
  height: 1440,
  checksumSha256: 'a'.repeat(64),
};

describe('the local schema reaches version 3', () => {
  it('creates evidence and the media-queue columns', async () => {
    expect(LOCAL_SCHEMA_VERSION).toBe(3);
    expect(await executor.userVersion()).toBe(3);

    const columns = await executor.query(`PRAGMA table_info(evidence)`, []);
    const names = columns.map((row) => String(row[1]));
    // §9.1's evidence table, including the `upload_attempts` it puts here rather than on
    // the outbox — it outlives the queue row, which is the point.
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'kind',
        'audit_id',
        'audit_zone_id',
        'question_response_id',
        'local_file_uri',
        'object_key',
        'checksum_sha256',
        'score_at_capture',
        'classification',
        'is_summary_flagged',
        'is_live_capture',
        'captured_at',
        'sync_state',
        'upload_attempts',
      ]),
    );

    const outboxColumns = await executor.query(`PRAGMA table_info(outbox)`, []);
    const outboxNames = outboxColumns.map((row) => String(row[1]));
    // §9.6's ten-minute stale-SYNCING sweep needs `started_at`; without it a row that
    // loses its process is stuck SYNCING forever and blocks logout with something that
    // will never retry.
    expect(outboxNames).toEqual(expect.arrayContaining(['started_at', 'batch_id', 'queue']));
  });

  it('is forward-only and idempotent — re-running it changes nothing', async () => {
    const { auditZoneId } = await auditWithZone();
    await captureLocalEvidence(database, {
      auditId: (await getLocalAuditZone(database, auditZoneId))[0]!.auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      ...PHOTO,
    });

    // A device that upgrades twice — an OTA landing while the app restarts — must not lose
    // the only copy of its unsynced work.
    await migrateLocalDatabase(executor);
    expect(await executor.userVersion()).toBe(3);
    expect(await listLocalEvidenceForZone(database, auditZoneId)).toHaveLength(1);
  });
});

describe('capturing a photograph (§9.1, §9.4)', () => {
  it('writes the row and both halves of the queue in one path', async () => {
    const { auditId, auditZoneId } = await auditWithZone();

    const evidenceId = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      classification: 'NONCONFORMITY',
      ...PHOTO,
    });

    const [row] = await getLocalEvidence(database, evidenceId);
    expect(row).toMatchObject({
      kind: 'WALK_BY_PHOTO',
      classification: 'NONCONFORMITY',
      syncState: 'LOCAL_ONLY',
      isLiveCapture: 1,
      byteSize: PHOTO.byteSize,
    });

    // The metadata rides the **media** queue: §9.3 separates large binary from the small
    // ordered JSON batch precisely so one 4 MB photo cannot delay fifty answers.
    const queued = await listOutbox(database);
    const media = queued.filter((item) => item.queue === 'media');
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ entityType: 'evidence', operation: 'upsert' });
  });

  it('moves a walk-by Zone off DRAFT on the first photograph (§7.2)', async () => {
    const { auditId, auditZoneId } = await auditWithZone();
    expect((await getLocalAuditZone(database, auditZoneId))[0]!.status).toBe('DRAFT');

    await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      ...PHOTO,
    });

    // A walk-by has no questionnaire, so the response upsert never fires. Without this the
    // Zone would sit in DRAFT for its whole life and could never be finished.
    const [zone] = await getLocalAuditZone(database, auditZoneId);
    expect(zone!.status).toBe('IN_PROGRESS');
    expect(zone!.startedAt).not.toBeNull();
  });

  it('does not push `started_at` forward on the second photograph', async () => {
    const { auditId, auditZoneId } = await auditWithZone();

    await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      ...PHOTO,
      now: '2026-09-09T08:00:00.000Z',
    });
    await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      ...PHOTO,
      checksumSha256: 'b'.repeat(64),
      now: '2026-09-09T09:30:00.000Z',
    });

    expect((await getLocalAuditZone(database, auditZoneId))[0]!.startedAt).toBe(
      '2026-09-09T08:00:00.000Z',
    );
  });
});

describe('invariant E-1 on the device', () => {
  it('classifies a question photograph from the answer that stands', async () => {
    const { auditId, auditZoneId } = await auditWithZone();
    const responseId = await saveLocalResponse(database, {
      auditZoneId,
      auditId,
      checklistQuestionId: 'q-01',
      section: 'S1_SORT',
      globalOrder: 1,
      value: 'SCORE_2',
    });

    const evidenceId = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'QUESTION_EVIDENCE',
      questionResponseId: responseId,
      scoreAtCapture: 'SCORE_2',
      ...PHOTO,
    });

    // The same `classifyEvidence` the server runs, so the tick the auditor sees offline is
    // the one the report will print.
    expect((await getLocalEvidence(database, evidenceId))[0]!.classification).toBe('GOOD');
  });

  it('leaves a photograph taken before its answer NEUTRAL, then re-files it (E-2)', async () => {
    const { auditId, auditZoneId } = await auditWithZone();

    // The auditor photographs first and judges second, which is the order the job happens.
    const evidenceId = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'QUESTION_EVIDENCE',
      ...PHOTO,
    });
    expect((await getLocalEvidence(database, evidenceId))[0]!.classification).toBe('NEUTRAL');

    const responseId = await saveLocalResponse(database, {
      auditZoneId,
      auditId,
      checklistQuestionId: 'q-01',
      section: 'S1_SORT',
      globalOrder: 1,
      value: 'SCORE_0',
    });

    // Linked after the fact, then reclassified — which is what the questionnaire does.
    await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'QUESTION_EVIDENCE',
      questionResponseId: responseId,
      scoreAtCapture: 'SCORE_0',
      checksumSha256: 'c'.repeat(64),
      localFileUri: 'file:///data/audit5s/photo-2.jpg',
      byteSize: PHOTO.byteSize,
    });

    await reclassifyLocalEvidence(database, responseId, 'SCORE_0');
    const photos = await listLocalEvidenceForZone(database, auditZoneId);
    const linked = photos.filter((photo) => photo.questionResponseId === responseId);
    expect(linked.every((photo) => photo.classification === 'NONCONFORMITY')).toBe(true);
  });

  it('drops the summary flag when a reclassification makes a photo NEUTRAL (E-3)', async () => {
    const { auditId, auditZoneId } = await auditWithZone();
    const responseId = await saveLocalResponse(database, {
      auditZoneId,
      auditId,
      checklistQuestionId: 'q-02',
      section: 'S1_SORT',
      globalOrder: 2,
      value: 'SCORE_2',
    });

    const evidenceId = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'QUESTION_EVIDENCE',
      questionResponseId: responseId,
      scoreAtCapture: 'SCORE_2',
      ...PHOTO,
    });

    expect(await setLocalSummaryFlag(database, evidenceId, true)).toEqual({ ok: true });

    // NA makes it NEUTRAL, and E-3 forbids a flagged NEUTRAL — the flag comes off in the
    // same statement rather than leaving a row the server's CHECK would refuse.
    await reclassifyLocalEvidence(database, responseId, 'NA');

    const [row] = await getLocalEvidence(database, evidenceId);
    expect(row).toMatchObject({ classification: 'NEUTRAL', isSummaryFlagged: 0 });
  });

  it('finds the response a question already has, or null', async () => {
    const { auditId, auditZoneId } = await auditWithZone();
    expect(await responseIdFor(database, auditZoneId, 'q-03')).toBeNull();

    const responseId = await saveLocalResponse(database, {
      auditZoneId,
      auditId,
      checklistQuestionId: 'q-03',
      section: 'S1_SORT',
      globalOrder: 3,
      value: 'SCORE_1',
    });
    expect(await responseIdFor(database, auditZoneId, 'q-03')).toBe(responseId);
  });
});

describe('§5.6 — one flagged photo of each classification per Zone', () => {
  async function flaggable(classification: 'GOOD' | 'NONCONFORMITY', seed: string) {
    const { auditId, auditZoneId } = await auditWithZone();
    const first = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      classification,
      ...PHOTO,
      checksumSha256: seed.repeat(64).slice(0, 64),
    });
    const second = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      classification,
      ...PHOTO,
      checksumSha256: 'd'.repeat(64),
      localFileUri: 'file:///data/audit5s/photo-2.jpg',
    });
    return { auditZoneId, first, second };
  }

  it('refuses the second flag of the same classification', async () => {
    const { first, second } = await flaggable('GOOD', 'a');

    expect(await setLocalSummaryFlag(database, first, true)).toEqual({ ok: true });
    // Locally enforced so the auditor finds out at the tap, not three hours later when the
    // queue drains. The partial unique indexes on the server are the actual control.
    expect(await setLocalSummaryFlag(database, second, true)).toEqual({
      ok: false,
      reason: 'TAKEN',
    });
  });

  it('allows one GOOD and one NONCONFORMITY in the same Zone', async () => {
    const { auditId, auditZoneId } = await auditWithZone();
    const good = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      classification: 'GOOD',
      ...PHOTO,
    });
    const bad = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      classification: 'NONCONFORMITY',
      ...PHOTO,
      checksumSha256: 'e'.repeat(64),
      localFileUri: 'file:///data/audit5s/photo-3.jpg',
    });

    expect(await setLocalSummaryFlag(database, good, true)).toEqual({ ok: true });
    expect(await setLocalSummaryFlag(database, bad, true)).toEqual({ ok: true });
  });

  it('refuses to flag a NEUTRAL photograph', async () => {
    const { auditId, auditZoneId } = await auditWithZone();
    const neutral = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      ...PHOTO,
    });

    expect(await setLocalSummaryFlag(database, neutral, false)).toEqual({ ok: true });
    expect(await setLocalSummaryFlag(database, neutral, true)).toEqual({
      ok: false,
      reason: 'NEUTRAL',
    });
  });

  it('frees the flag when the flagged photo is deleted', async () => {
    const { first, second } = await flaggable('NONCONFORMITY', 'f');

    await setLocalSummaryFlag(database, first, true);
    await deleteLocalEvidence(database, first);

    expect(await setLocalSummaryFlag(database, second, true)).toEqual({ ok: true });
  });
});

describe('deleting a photograph before completion (E-4, §9.4)', () => {
  it('cancels the queued upload when the server has never seen it', async () => {
    const { auditId, auditZoneId } = await auditWithZone();
    const evidenceId = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      ...PHOTO,
    });

    expect((await listOutbox(database)).filter((i) => i.entityType === 'evidence')).toHaveLength(1);

    await deleteLocalEvidence(database, evidenceId);

    // §9.4: "Outbox media row cancelled if still PENDING." Telling the server about a
    // photograph it has no row for would be a delete for something that never existed.
    expect((await listOutbox(database)).filter((i) => i.entityType === 'evidence')).toHaveLength(0);
    expect(await listLocalEvidenceForZone(database, auditZoneId)).toHaveLength(0);

    // Soft, not hard: the row survives, exactly as on the server.
    const rows = await executor.query(`SELECT deleted_at FROM evidence WHERE id = ?`, [evidenceId]);
    expect(rows[0]?.[0]).not.toBeNull();
  });

  it('queues a delete when the server already has the row', async () => {
    const { auditId, auditZoneId } = await auditWithZone();
    const evidenceId = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      ...PHOTO,
    });

    await markEvidenceIntentIssued(database, evidenceId, 'evidence/u/a/z/e.jpg');
    await markEvidenceSynced(database, evidenceId);
    await deleteLocalEvidence(database, evidenceId);

    const queued = await listOutbox(database);
    expect(queued.filter((i) => i.entityType === 'evidence' && i.operation === 'delete')).toHaveLength(
      1,
    );
  });
});

describe('the two-phase media commit on the device (§9.4, §9.6)', () => {
  it('records the minted key and queues the commit as a separate item', async () => {
    const { auditId, auditZoneId } = await auditWithZone();
    const evidenceId = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      ...PHOTO,
    });

    await markEvidenceIntentIssued(database, evidenceId, 'evidence/u/a/z/e.jpg');
    expect((await getLocalEvidence(database, evidenceId))[0]).toMatchObject({
      objectKey: 'evidence/u/a/z/e.jpg',
      syncState: 'SYNCING',
    });

    await queueEvidenceCommit(database, evidenceId);

    // Queued, not called: an app killed between the PUT and the confirmation finds the
    // commit still pending and replays it, which is §9.6's recovery path.
    const commit = (await listOutbox(database)).find((i) => i.operation === 'commit');
    expect(commit).toBeTruthy();
    expect(JSON.parse(commit!.payload)).toMatchObject({ checksumSha256: PHOTO.checksumSha256 });
  });
});

describe('the gates the device answers offline', () => {
  it('answers the §7.1 selfie gate from SQLite', async () => {
    const { auditId } = await auditWithZone();
    expect(await hasLocalSelfie(database, auditId)).toBe(false);

    await captureLocalEvidence(database, {
      auditId,
      kind: 'AUDITOR_SELFIE',
      ...PHOTO,
    });
    expect(await hasLocalSelfie(database, auditId)).toBe(true);
  });

  it('does not accept a gallery image as a selfie (§12.10)', async () => {
    const { auditId } = await auditWithZone();
    await captureLocalEvidence(database, {
      auditId,
      kind: 'AUDITOR_SELFIE',
      isLiveCapture: false,
      ...PHOTO,
    });
    expect(await hasLocalSelfie(database, auditId)).toBe(false);
  });

  it('answers the §7.2 walk-by gate from SQLite', async () => {
    const { auditId, auditZoneId } = await auditWithZone();
    expect(await zoneHasLocalEvidence(database, auditZoneId)).toBe(false);

    await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      ...PHOTO,
    });
    expect(await zoneHasLocalEvidence(database, auditZoneId)).toBe(true);
  });

  it('counts photographs separately from items, as §9.9 asks', async () => {
    const { auditId, auditZoneId } = await auditWithZone();
    expect(await pendingPhotoCount(database)).toBe(0);

    const evidenceId = await captureLocalEvidence(database, {
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      ...PHOTO,
    });
    expect(await pendingPhotoCount(database)).toBe(1);

    await markEvidenceSynced(database, evidenceId);
    expect(await pendingPhotoCount(database)).toBe(0);
  });
});
