import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abortLocalAudit, addLocalZone, createLocalAudit } from './audit.repository';
import { captureLocalEvidence, deleteLocalEvidence, markEvidenceSynced } from './evidence.repository';
import { replaceCatalogue } from './catalogue.repository';
import { createLocalDatabase, migrateLocalDatabase, type LocalDatabase } from './local-database';
import { createNodeExecutor } from './node-executor';
import { planPhotoBackup, recordPhotoBackup, settlePhotoBackup } from './photo-backup.repository';
import { FIXTURE_UNIT as UNIT, catalogue } from './test-fixtures';

/** Which photos the gallery folder copies, and what it tidies, against real SQLite (R-62). */

let executor: ReturnType<typeof createNodeExecutor>;
let database: LocalDatabase;

beforeEach(async () => {
  executor = createNodeExecutor();
  await migrateLocalDatabase(executor);
  database = createLocalDatabase(executor);
  await replaceCatalogue(database, catalogue());
});

afterEach(() => executor.close());

const PHOTO = {
  localFileUri: 'file:///photo.jpg',
  byteSize: 1024,
  checksumSha256: 'a'.repeat(64),
  contentType: 'image/jpeg',
};

async function photo(): Promise<{ auditId: string; evidenceId: string }> {
  const auditId = await createLocalAudit(database, { unitId: UNIT, auditType: 'WALK_BY', checklistVersionId: null });
  const auditZoneId = await addLocalZone(database, { auditId, zoneNumber: 1, sequenceNo: 1, checklistVersionId: null });
  const evidenceId = await captureLocalEvidence(database, { auditId, auditZoneId, kind: 'WALK_BY_PHOTO', ...PHOTO });
  return { auditId, evidenceId };
}

async function backUp(evidenceId: string) {
  await recordPhotoBackup(database, {
    evidenceId,
    photoUri: `saf://${evidenceId}.jpg`,
    sidecarUri: `saf://${evidenceId}.json`,
  });
}

describe('the gallery copy plan', () => {
  it('copies a photo once, with its upload request while it still waits to upload', async () => {
    const { evidenceId } = await photo();
    const { write } = await planPhotoBackup(database);
    expect(write.map((row) => row.evidenceId)).toEqual([evidenceId]);
    expect(write[0]!.payload).toMatchObject({ id: evidenceId, kind: 'WALK_BY_PHOTO' });

    await backUp(evidenceId);
    expect((await planPhotoBackup(database)).write).toEqual([]);
  });

  it('copies a photo already uploaded too, with no upload request', async () => {
    const { evidenceId } = await photo();
    await markEvidenceSynced(database, evidenceId);
    const { write } = await planPhotoBackup(database);
    expect(write).toEqual([expect.objectContaining({ evidenceId })]);
  });

  it('keeps the copy once uploaded, dropping only its recovery file', async () => {
    const { evidenceId } = await photo();
    await backUp(evidenceId);
    await markEvidenceSynced(database, evidenceId);

    const { settle, drop } = await planPhotoBackup(database);
    expect(settle.map((row) => row.evidenceId)).toEqual([evidenceId]);
    expect(drop).toEqual([]);

    await settlePhotoBackup(database, evidenceId);
    expect((await planPhotoBackup(database)).settle).toEqual([]);
  });

  it('drops both files of a photo deleted, or of an aborted audit', async () => {
    const deleted = await photo();
    const aborted = await photo();
    const waiting = await photo();
    for (const p of [deleted, aborted, waiting]) await backUp(p.evidenceId);

    await deleteLocalEvidence(database, deleted.evidenceId);
    await abortLocalAudit(database, aborted.auditId);

    const { drop, settle } = await planPhotoBackup(database);
    expect(drop.map((row) => row.evidenceId).sort()).toEqual([deleted.evidenceId, aborted.evidenceId].sort());
    expect(settle).toEqual([]);
  });
});
