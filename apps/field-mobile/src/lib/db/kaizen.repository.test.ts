import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Kaizen, KaizenFields, SyncBatchRequest } from '@audit5s/contracts';
import { runSync } from '../sync/engine';
import type { SyncTransport } from '../sync/transport';
import { listOutbox } from './audit.repository';
import {
  addLocalKaizenPhoto,
  createLocalKaizen,
  getLocalKaizen,
  getLocalKaizenPhoto,
  localKaizenCounts,
  refreshLocalKaizens,
  removeLocalKaizenPhoto,
  saveLocalKaizenFields,
  submitLocalKaizen,
} from './kaizen.repository';
import { createLocalDatabase, migrateLocalDatabase, type LocalDatabase } from './local-database';
import { createNodeExecutor } from './node-executor';
import { FIXTURE_UNIT, FIXTURE_ZONE_A } from './test-fixtures';

/** A Zone Leader's Kaizens on the device, against real SQLite (R-48, step 4). */

let executor: ReturnType<typeof createNodeExecutor>;
let database: LocalDatabase;

const ZONE = { id: FIXTURE_ZONE_A, code: 'Z07', name: 'Press Shop' };
const SHA = 'a'.repeat(64);

const COMPLETE: KaizenFields = {
  machine: '250T Press P-04',
  lineArea: 'Line 3',
  implementedOn: '2026-10-03',
  teamMembers: 'Sunita Kale, Rahul Pawar',
  theme: 'Die change cut from 42 to 18 min',
  problem5w1h: 'Changeover takes 42 minutes',
  countermeasure: 'Quick-release clamps',
  horizontalDeployment: false,
  benefits: '24 minutes a changeover',
  rootCause4m: 'Method: bolted clamps',
  ideaBy: 'Sunita Kale',
  implementedBy: 'Maintenance',
};

beforeEach(async () => {
  executor = createNodeExecutor();
  await migrateLocalDatabase(executor);
  database = createLocalDatabase(executor);
});

afterEach(() => {
  executor.close();
});

function newKaizen(sheet?: KaizenFields) {
  return createLocalKaizen(database, { unitId: FIXTURE_UNIT, zone: ZONE, ...(sheet ? { sheet } : {}) });
}

function photo(kaizenId: string, kind: 'BEFORE' | 'AFTER' = 'BEFORE') {
  return addLocalKaizenPhoto(database, {
    kaizenId,
    kind,
    localFileUri: `file:///kaizen/${kind}.jpg`,
    byteSize: 1234,
    checksumSha256: SHA,
    width: 1920,
    height: 1080,
    isLiveCapture: false,
  });
}

describe('a draft, offline', () => {
  it('queues one upsert carrying the whole sheet, however many fields are saved', async () => {
    const id = await newKaizen();
    await saveLocalKaizenFields(database, id, { theme: 'Shadow board' });
    await saveLocalKaizenFields(database, id, { machine: 'Line 3' });

    const items = (await listOutbox(database)).filter((row) => row.entityType === 'kaizen');
    expect(items).toHaveLength(1);
    expect(JSON.parse(items[0]!.payload)).toMatchObject({ zoneId: ZONE.id, theme: 'Shadow board', machine: 'Line 3' });
    expect((await getLocalKaizen(database, id))?.kaizenNo).toBeNull();
  });

  it('refuses Submit until every required step is filled, then locks the sheet', async () => {
    const id = await newKaizen({ theme: 'Half done' });
    await expect(submitLocalKaizen(database, id)).rejects.toThrow(/required/);

    await saveLocalKaizenFields(database, id, COMPLETE);
    await submitLocalKaizen(database, id);

    expect((await getLocalKaizen(database, id))?.status).toBe('SUBMITTED');
    await expect(saveLocalKaizenFields(database, id, { theme: 'Too late' })).rejects.toThrow(/draft/);
    const submit = (await listOutbox(database)).find((row) => row.entityType === 'kaizen_submission');
    expect(JSON.parse(submit!.payload)).toEqual({ kaizenId: id });
  });
});

describe('photos', () => {
  it('replacing a photo that never left the phone cancels it without telling the server', async () => {
    const id = await newKaizen();
    const first = await photo(id);
    const second = await photo(id);

    expect((await getLocalKaizenPhoto(database, id, 'BEFORE'))?.id).toBe(second);
    expect(await getLocalKaizen(database, id)).toMatchObject({ before: { id: second }, after: null });
    const items = (await listOutbox(database)).filter((row) => row.entityType === 'kaizen_photo');
    expect(items.map((row) => [row.entityId, row.operation, row.queue])).toEqual([[second, 'upsert', 'media']]);
    void first;
  });

  it('removing one the server holds queues a delete', async () => {
    const id = await newKaizen();
    const photoId = await photo(id);
    await runSync(database, fakeServer().transport, { deviceId: 'device' });

    await removeLocalKaizenPhoto(database, photoId);
    const items = (await listOutbox(database)).filter((row) => row.entityType === 'kaizen_photo');
    expect(items.map((row) => row.operation)).toEqual(['delete']);
  });
});

describe('sync', () => {
  it('sends the sheet, uploads the photo, commits it, then the submission, in that order', async () => {
    const id = await newKaizen(COMPLETE);
    const photoId = await photo(id);
    await submitLocalKaizen(database, id);
    const server = fakeServer();

    await runSync(database, server.transport, { deviceId: 'device' });

    expect(server.sent).toEqual(['kaizen:upsert', 'intent', 'put', 'kaizen_photo:commit', 'kaizen_submission:submit']);
    expect(await listOutbox(database)).toEqual([]);
    expect((await getLocalKaizenPhoto(database, id, 'BEFORE'))?.uploadedAt).not.toBeNull();
    expect((await getLocalKaizen(database, id))).toMatchObject({ status: 'SUBMITTED', pendingSubmissionId: null });
    void photoId;
  });
});

describe('the pull', () => {
  it("writes the server's copy over a settled Kaizen, and never over one with work unsent", async () => {
    const settled = await newKaizen(COMPLETE);
    const busy = await newKaizen({ theme: 'Mine, offline' });
    await runSync(database, fakeServer().transport, { deviceId: 'device' });
    await saveLocalKaizenFields(database, busy, { theme: 'Edited again' });

    await refreshLocalKaizens(database, [
      server(settled, { status: 'SENT_BACK', kaizenNo: 'KZ-Z07-014', comment: 'Add the logbook times.' }),
      server(busy, { status: 'DRAFT', kaizenNo: 'KZ-Z07-015' }),
    ]);

    expect(await getLocalKaizen(database, settled)).toMatchObject({
      status: 'SENT_BACK',
      kaizenNo: 'KZ-Z07-014',
      reviewComment: 'Add the logbook times.',
    });
    expect((await getLocalKaizen(database, busy))?.sheet.theme).toBe('Edited again');
    expect(await localKaizenCounts(database)).toEqual({ sentBack: 1, drafts: 1 });
  });
});

// ---------------------------------------------------------------------------- helpers

/** A server that accepts everything, and records what arrived in what order. */
function fakeServer() {
  const sent: string[] = [];
  const transport: SyncTransport = {
    async pushBatch(request: SyncBatchRequest) {
      sent.push(...request.items.map((item) => `${item.entityType}:${item.operation}`));
      return {
        batchId: request.batchId,
        serverTime: new Date().toISOString(),
        replayed: false,
        results: request.items.map((item) => ({ outboxId: item.outboxId, entityId: item.entityId, status: 'ACCEPTED' as const })),
      };
    },
    uploadIntent: () => Promise.reject(new Error('No 5S photos here')),
    async kaizenPhotoUploadIntent(_kaizenId, payload) {
      sent.push('intent');
      return {
        photoId: payload.id as string,
        objectKey: `kaizen/${String(payload.id)}.jpg`,
        uploadUrl: 'http://storage.test/put',
        requiredHeaders: {},
        expiresIn: 900,
        alreadyExists: false,
      };
    },
    async uploadObject() {
      sent.push('put');
    },
    status: () => Promise.reject(new Error('unused')),
  };
  return { transport, sent };
}

function server(
  id: string,
  input: { status: Kaizen['status']; kaizenNo: string; comment?: string },
): Kaizen {
  const at = '2026-10-05T10:00:00.000Z';
  return {
    id,
    kaizenNo: input.kaizenNo,
    unitId: FIXTURE_UNIT,
    unitName: 'Nashik Plant',
    zoneId: ZONE.id,
    zoneCode: ZONE.code,
    zoneName: ZONE.name,
    department: null,
    authorUserId: 'aaaaaaaa-0000-4000-8000-0000000000aa',
    authorName: 'Sunita Kale',
    machine: null,
    lineArea: null,
    implementedOn: null,
    teamMembers: null,
    theme: 'From the server',
    target: null,
    problem5w1h: null,
    rootCause4m: null,
    analysis7qc: null,
    countermeasure: null,
    wastes: [],
    parameters: [],
    horizontalDeployment: null,
    benefits: null,
    annualSaving: null,
    ideaBy: null,
    implementedBy: null,
    status: input.status,
    submittedAt: input.status === 'DRAFT' ? null : at,
    latestReview: input.comment
      ? {
          id: 'bbbbbbbb-0000-4000-8000-000000000001',
          kaizenId: id,
          reviewerUserId: 'aaaaaaaa-0000-4000-8000-0000000000bb',
          reviewerName: 'Coordinator',
          reviewerRole: 'COORDINATOR',
          decision: 'SENT_BACK',
          comment: input.comment,
          createdAt: at,
        }
      : null,
    beforePhoto: null,
    afterPhoto: null,
    createdAt: at,
    updatedAt: at,
  };
}
