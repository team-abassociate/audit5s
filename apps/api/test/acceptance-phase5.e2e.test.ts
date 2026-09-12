import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  type AuditDetail,
  type Evidence,
  type Page,
  type SyncBatchRequest,
  type SyncBatchResponse,
  type SyncCatalogue,
  type SyncStatus,
  type UploadIntentResponse,
} from '@audit5s/contracts';
import { loginFromDevice, startWorld, stopWorld, type TestWorld } from './harness';
import {
  addLocalZone,
  completeLocalAudit,
  completeLocalZone,
  createLocalAudit,
  listOutbox,
  pendingOutboxCount,
  saveZoneRemark,
} from '../../field-mobile/src/lib/db/audit.repository';
import {
  captureLocalEvidence,
  setLocalSummaryFlag,
  zoneHasLocalEvidence,
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

/**
 * Phase 5 acceptance, literally: three photographed Zones finish offline and sync; a
 * photo-less fourth Zone is stopped locally and refused if that gate is bypassed; each
 * completed Zone has one flagged GOOD and one flagged NONCONFORMITY photograph.
 */

let world: TestWorld;
let database: LocalDatabase;
let executor: ReturnType<typeof createNodeExecutor>;
let consultantToken: string;
let offline = false;

const base = API_BASE_PATH;
const DEVICE_ID = '01930000-0000-7000-8000-0000000a5001';
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);
const CHECKSUM = createHash('sha256').update(TINY_JPEG).digest('hex');
const zoneIds: string[] = [];

async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  if (offline) throw new Error(`The device is offline; ${method} ${path} must not be attempted`);
  return world.request(method, path, {
    token: consultantToken,
    headers: { 'x-device-id': DEVICE_ID, ...(options.headers ?? {}) },
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

const transport: SyncTransport = {
  async pushBatch(request: SyncBatchRequest): Promise<SyncBatchResponse> {
    const response = await call('POST', `${base}/sync/batch`, { body: request });
    if (response.status !== 200) throw new TransportError(JSON.stringify(response.body), response.status);
    return response.body as SyncBatchResponse;
  },
  async uploadIntent(payload): Promise<UploadIntentResponse> {
    const response = await call('POST', `${base}/evidence/upload-intent`, { body: payload });
    if (response.status !== 201) throw new TransportError(JSON.stringify(response.body), response.status);
    return response.body as UploadIntentResponse;
  },
  async uploadObject(intent, _localFileUri, contentType): Promise<void> {
    if (offline) throw new Error('The device is offline; the object upload must not be attempted');
    const response = await world.app.inject({
      method: 'PUT',
      url: intent.uploadUrl.replace(/^https?:\/\/[^/]+/, ''),
      headers: { 'content-type': contentType },
      payload: TINY_JPEG,
    });
    if (response.statusCode !== 200) throw new TransportError(response.body, response.statusCode);
  },
  async status(): Promise<SyncStatus> {
    const response = await call('GET', `${base}/sync/status`);
    return response.body as SyncStatus;
  },
};

const sync = () => runSync(database, transport, { deviceId: DEVICE_ID, appVersion: '1.5.0' });

beforeAll(async () => {
  world = await startWorld();
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, DEVICE_ID);

  for (let index = 0; index < 4; index += 1) {
    const { rows } = await world.owner.query(
      `INSERT INTO zone (unit_id, code, name, description, zone_leader_id, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        world.unitA,
        `Z-5${index + 1}`,
        `Walk-by Zone ${index + 1}`,
        `Bay ${index + 1}`,
        world.actors.ZONE_LEADER.userId,
        index + 1,
      ],
    );
    zoneIds.push(rows[0].id as string);
  }

  executor = createNodeExecutor();
  await migrateLocalDatabase(executor);
  database = createLocalDatabase(executor);
}, 180_000);

afterAll(async () => {
  executor?.close();
  await stopWorld(world);
});

async function capture(
  auditId: string,
  auditZoneId: string | null,
  classification?: 'GOOD' | 'NONCONFORMITY',
): Promise<string> {
  return captureLocalEvidence(database, {
    auditId,
    ...(auditZoneId ? { auditZoneId } : {}),
    kind: auditZoneId ? 'WALK_BY_PHOTO' : 'AUDITOR_SELFIE',
    ...(classification ? { classification } : {}),
    localFileUri: `file:///data/audit5s/${randomUUID()}.jpg`,
    byteSize: TINY_JPEG.byteLength,
    checksumSha256: CHECKSUM,
  });
}

async function drain(): Promise<void> {
  let pending = await pendingOutboxCount(database);
  let cycles = 0;
  while (pending > 0 && cycles < 10) {
    await sync();
    pending = await pendingOutboxCount(database);
    cycles += 1;
  }
  const stuck = (await listOutbox(database)).filter((item) => item.state !== 'SYNCED');
  expect(
    pending,
    stuck.map((item) => `${item.entityType}:${item.operation} ${item.lastError ?? ''}`).join('\n'),
  ).toBe(0);
}

describe('Phase 5 acceptance', () => {
  it('completes the photographed walk-by offline and enforces the fourth-Zone photo gate', async () => {
    const catalogueResponse = await call('GET', `${base}/sync/catalogue`);
    expect(catalogueResponse.status).toBe(200);
    const catalogue = catalogueResponse.body as SyncCatalogue;
    await replaceCatalogue(database, catalogue);
    expect(catalogue.zones.map((zone) => zone.id)).toEqual(expect.arrayContaining(zoneIds));

    offline = true;
    const auditId = await createLocalAudit(database, {
      unitId: world.unitA,
      auditType: 'WALK_BY',
      checklistVersionId: null,
    });
    await capture(auditId, null);

    const auditZoneIds: string[] = [];
    for (const [index, zoneId] of zoneIds.slice(0, 3).entries()) {
      const auditZoneId = await addLocalZone(database, {
        auditId,
        zoneId,
        sequenceNo: index + 1,
        checklistVersionId: null,
        zoneDescription: `Observed bay ${index + 1}`,
        zoneLeaderUserId: world.actors.ZONE_LEADER.userId,
      });
      auditZoneIds.push(auditZoneId);

      const good = await capture(auditId, auditZoneId, 'GOOD');
      const nonconformity = await capture(auditId, auditZoneId, 'NONCONFORMITY');
      const extraGood = await capture(auditId, auditZoneId, 'GOOD');
      expect(await setLocalSummaryFlag(database, good, true)).toEqual({ ok: true });
      expect(await setLocalSummaryFlag(database, nonconformity, true)).toEqual({ ok: true });
      expect(await setLocalSummaryFlag(database, extraGood, true)).toEqual({
        ok: false,
        reason: 'TAKEN',
      });

      await saveZoneRemark(database, auditZoneId, `Walk-by Zone ${index + 1} remark`);
      await completeLocalZone(database, auditZoneId);
    }
    await completeLocalAudit(database, auditId);

    // Every write above used SQLite only. Any HTTP attempt would have thrown through call().
    expect(await pendingOutboxCount(database)).toBeGreaterThan(0);
    offline = false;
    await drain();

    const detailResponse = await call('GET', `${base}/audits/${auditId}`);
    const detail = detailResponse.body as AuditDetail;
    // A walk-by nonconformity opens a corrective action (§2.7), so the audit rolls on.
    expect(detail.status).toBe('CORRECTIVE_ACTION_OPEN');
    expect(detail.scored).toBe(false);
    expect(detail.zones).toHaveLength(3);
    expect(detail.zones.every((zone) => zone.status === 'COMPLETED')).toBe(true);

    const galleryResponse = await call('GET', `${base}/audits/${auditId}/evidence?limit=200`);
    const photos = (galleryResponse.body as Page<Evidence>).data.filter(
      (evidence) => evidence.kind === 'WALK_BY_PHOTO',
    );
    expect(photos).toHaveLength(9);
    for (const auditZoneId of auditZoneIds) {
      const flagged = photos.filter(
        (evidence) => evidence.auditZoneId === auditZoneId && evidence.isSummaryFlagged,
      );
      expect(flagged.map((evidence) => evidence.classification).sort()).toEqual([
        'GOOD',
        'NONCONFORMITY',
      ]);
    }

    // A separate fourth Zone proves both halves of the same gate without making the
    // successfully completed three-Zone audit internally contradictory.
    offline = true;
    const refusedAuditId = await createLocalAudit(database, {
      unitId: world.unitA,
      auditType: 'WALK_BY',
      checklistVersionId: null,
    });
    await capture(refusedAuditId, null);
    const emptyZoneId = await addLocalZone(database, {
      auditId: refusedAuditId,
      zoneId: zoneIds[3]!,
      sequenceNo: 1,
      checklistVersionId: null,
    });

    await expect(
      (async () => {
        if (!(await zoneHasLocalEvidence(database, emptyZoneId))) {
          throw new Error('Take at least one photograph before finishing this Zone.');
        }
        await completeLocalZone(database, emptyZoneId);
      })(),
    ).rejects.toThrow('Take at least one photograph');

    // Bypass the screen's gate deliberately: the queued completion must still be refused.
    await completeLocalZone(database, emptyZoneId);
    offline = false;
    const result = await sync();
    expect(result.failed).toBe(1);
    const refused = (await listOutbox(database)).find(
      (item) => item.entityId === emptyZoneId && item.operation === 'complete',
    );
    expect(refused).toMatchObject({ state: 'DEAD_LETTER' });
    expect(refused?.lastError).toMatch(/photograph|evidence/i);

    const serverZone = await world.owner.query(`SELECT status FROM audit_zone WHERE id = $1`, [
      emptyZoneId,
    ]);
    expect(serverZone.rows[0].status).not.toBe('COMPLETED');
  });
});
