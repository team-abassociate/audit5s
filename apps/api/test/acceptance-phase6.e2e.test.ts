import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  type Audit,
  type CorrectiveAction,
  type CorrectiveActionDetail,
  type Page,
  type SyncBatchRequest,
  type SyncBatchResponse,
  type SyncCatalogue,
  type SyncStatus,
  type UploadIntentResponse,
} from '@audit5s/contracts';
import { NotificationWorker } from '../src/modules/notifications/notification.worker';
import { loginFromDevice, startWorld, stopWorld, type TestWorld } from './harness';
import { drainNotifications, forgetQueuedNotifications } from './corrective-fixtures';
import {
  addLocalZone,
  completeLocalAudit,
  completeLocalZone,
  createLocalAudit,
  listOutbox,
  pendingOutboxCount,
} from '../../field-mobile/src/lib/db/audit.repository';
import { captureLocalEvidence } from '../../field-mobile/src/lib/db/evidence.repository';
import { replaceCatalogue } from '../../field-mobile/src/lib/db/catalogue.repository';
import {
  captureAfterPhoto,
  listLocalCorrectiveActions,
  submitLocalCorrectiveAction,
} from '../../field-mobile/src/lib/db/corrective-action.repository';
import {
  createLocalDatabase,
  migrateLocalDatabase,
  type LocalDatabase,
} from '../../field-mobile/src/lib/db/local-database';
import { createNodeExecutor } from '../../field-mobile/src/lib/db/node-executor';
import { runSync } from '../../field-mobile/src/lib/sync/engine';
import { TransportError, type SyncTransport } from '../../field-mobile/src/lib/sync/transport';

/**
 * Phase 6 acceptance, literally:
 *
 * > Completing an audit with 5 nonconformities opens 5 independent actions; submitting 3,
 * > then 2 a week later, preserves all 5; each submission notifies Super Admin;
 * > verification closes the audit.
 *
 * Both devices are the real device code — the local repositories and `runSync` — and the
 * module-level `offline` switch makes every HTTP call throw, so each "offline" below is
 * enforced by the test rather than claimed by it (the Phase 4 shape).
 */

let world: TestWorld;
let offline = false;
const base = API_BASE_PATH;
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);
const CHECKSUM = createHash('sha256').update(TINY_JPEG).digest('hex');

interface Device {
  id: string;
  token: string;
  database: LocalDatabase;
  executor: ReturnType<typeof createNodeExecutor>;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  sync: () => ReturnType<typeof runSync>;
  drain: () => Promise<void>;
}

async function device(id: string, token: string): Promise<Device> {
  const executor = createNodeExecutor();
  await migrateLocalDatabase(executor);
  const database = createLocalDatabase(executor);

  const call: Device['call'] = async (method, path, body) => {
    if (offline) throw new Error(`The device is offline; ${method} ${path} must not be attempted`);
    return world.request(method, path, {
      token,
      headers: { 'x-device-id': id },
      ...(body !== undefined ? { body } : {}),
    });
  };

  const transport: SyncTransport = {
    async pushBatch(request: SyncBatchRequest): Promise<SyncBatchResponse> {
      const response = await call('POST', `${base}/sync/batch`, request);
      if (response.status !== 200) throw new TransportError(JSON.stringify(response.body), response.status);
      return response.body as SyncBatchResponse;
    },
    async uploadIntent(payload): Promise<UploadIntentResponse> {
      const response = await call('POST', `${base}/evidence/upload-intent`, payload);
      if (response.status !== 201) throw new TransportError(JSON.stringify(response.body), response.status);
      return response.body as UploadIntentResponse;
    },
    async uploadObject(intent, _uri, contentType): Promise<void> {
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
      return (await call('GET', `${base}/sync/status`)).body as SyncStatus;
    },
  };

  const sync = () => runSync(database, transport, { deviceId: id, appVersion: '1.6.0' });
  const drain = async () => {
    for (let cycle = 0; cycle < 10 && (await pendingOutboxCount(database)) > 0; cycle += 1) {
      await sync();
    }
    const stuck = (await listOutbox(database)).filter((item) => item.state !== 'SYNCED');
    expect(
      await pendingOutboxCount(database),
      stuck.map((item) => `${item.entityType}:${item.operation} ${item.lastError ?? ''}`).join('\n'),
    ).toBe(0);
  };

  return { id, token, database, executor, call, sync, drain };
}

let consultant: Device;
let leader: Device;
let worker: NotificationWorker;
let zoneId: string;

beforeAll(async () => {
  world = await startWorld();
  await forgetQueuedNotifications(world);
  worker = world.app.get(NotificationWorker);

  const { rows } = await world.owner.query(
    `INSERT INTO zone (unit_id, code, name, zone_leader_id) VALUES ($1, '6', 'Press line', $2) RETURNING id`,
    [world.unitA, world.actors.ZONE_LEADER.userId],
  );
  zoneId = rows[0].id as string;

  const consultantDevice = '01930000-0000-7000-8000-0000000a6001';
  const leaderDevice = '01930000-0000-7000-8000-0000000a6002';
  consultant = await device(consultantDevice, await loginFromDevice(world, world.actors.CONSULTANT, consultantDevice));
  leader = await device(leaderDevice, await loginFromDevice(world, world.actors.ZONE_LEADER, leaderDevice));
}, 180_000);

afterAll(async () => {
  consultant?.executor.close();
  leader?.executor.close();
  await stopWorld(world);
});

function photo() {
  return { localFileUri: `file:///data/audit5s/${randomUUID()}.jpg`, byteSize: TINY_JPEG.byteLength, checksumSha256: CHECKSUM };
}

async function leaderAnswers(action: { id: string; auditId: string }, option: 'A' | 'B', note: string) {
  if (option === 'B') {
    return submitLocalCorrectiveAction(leader.database, { actionId: action.id, option: 'NOT_POSSIBLE', explanation: note });
  }
  const submissionId = randomUUID();
  const afterEvidenceId = await captureAfterPhoto(leader.database, { action, submissionId, ...photo() });
  return submitLocalCorrectiveAction(leader.database, {
    actionId: action.id,
    submissionId,
    option: 'COMPLETED',
    submittedByName: 'Zoe Leader',
    description: note,
    afterEvidenceId,
  });
}

async function detail(actionId: string): Promise<CorrectiveActionDetail> {
  const response = await world.request('GET', `${base}/corrective-actions/${actionId}`, {
    token: world.actors.SUPER_ADMIN.accessToken,
  });
  return response.body as CorrectiveActionDetail;
}

describe('Phase 6 acceptance', () => {
  it('opens five actions, keeps Monday’s three through Friday’s two, notifies, and closes on verification', async () => {
    // --- A Consultant completes a walk-by with five nonconformities, offline, then syncs.
    await replaceCatalogue(consultant.database, (await consultant.call('GET', `${base}/sync/catalogue`)).body as SyncCatalogue);
    offline = true;
    const auditId = await createLocalAudit(consultant.database, { unitId: world.unitA, auditType: 'WALK_BY', checklistVersionId: null });
    await captureLocalEvidence(consultant.database, { auditId, kind: 'AUDITOR_SELFIE', ...photo() });
    const auditZoneId = await addLocalZone(consultant.database, { auditId, zoneId, sequenceNo: 1, checklistVersionId: null });
    for (let i = 0; i < 5; i += 1) {
      await captureLocalEvidence(consultant.database, {
        auditId,
        auditZoneId,
        kind: 'WALK_BY_PHOTO',
        classification: 'NONCONFORMITY',
        ...photo(),
      });
    }
    await completeLocalZone(consultant.database, auditZoneId);
    await completeLocalAudit(consultant.database, auditId);
    offline = false;
    await consultant.drain();

    const audit = (await world.request('GET', `${base}/audits/${auditId}`, { token: world.actors.SUPER_ADMIN.accessToken }))
      .body as Audit;
    expect(audit.status).toBe('CORRECTIVE_ACTION_OPEN');
    const opened = (
      (await world.request('GET', `${base}/corrective-actions?auditId=${auditId}`, { token: world.actors.SUPER_ADMIN.accessToken }))
        .body as Page<CorrectiveAction>
    ).data;
    expect(opened).toHaveLength(5);
    expect(new Set(opened.map((action) => action.evidenceId)).size).toBe(5);

    // --- The Zone Leader's device picks them up, then goes out of signal.
    await replaceCatalogue(leader.database, (await leader.call('GET', `${base}/sync/catalogue`)).body as SyncCatalogue);
    const onDevice = (await listLocalCorrectiveActions(leader.database)).filter((action) => action.auditId === auditId);
    expect(onDevice).toHaveLength(5);

    // --- Monday: three answers, with the radio off.
    offline = true;
    await leaderAnswers(onDevice[0]!, 'A', 'Rack relabelled');
    await leaderAnswers(onDevice[1]!, 'A', 'Aisle cleared');
    await leaderAnswers(onDevice[2]!, 'B', 'The panel belongs to the landlord');
    offline = false;
    await leader.drain();

    const monday = await Promise.all(onDevice.map((action) => detail(action.id)));
    expect(monday.map((action) => action.submissions.length)).toEqual([1, 1, 1, 0, 0]);
    expect(monday.slice(3).every((action) => action.status === 'OPEN')).toBe(true);

    // --- A week later: the other two, offline again.
    await replaceCatalogue(leader.database, (await leader.call('GET', `${base}/sync/catalogue`)).body as SyncCatalogue);
    offline = true;
    await leaderAnswers(onDevice[3]!, 'A', 'Floor marking repainted');
    await leaderAnswers(onDevice[4]!, 'B', 'Awaiting a replacement part');
    offline = false;
    await leader.drain();

    const friday = await Promise.all(onDevice.map((action) => detail(action.id)));
    expect(friday.map((action) => action.submissions.length)).toEqual([1, 1, 1, 1, 1]);
    // All five preserved, and Monday's three exactly as Monday left them.
    expect(friday.slice(0, 3).map((action) => action.submissions)).toEqual(monday.slice(0, 3).map((action) => action.submissions));
    expect(friday.every((action) => action.submissions[0]!.submittedVia === 'MOBILE')).toBe(true);

    // --- Each submission notified the Super Admin.
    await drainNotifications(world, worker);
    const { rows: told } = await world.owner.query(
      `SELECT resource_id FROM notification
        WHERE recipient_user_id = $1 AND event_type = 'CORRECTIVE_ACTION_SUBMITTED'`,
      [world.actors.SUPER_ADMIN.userId],
    );
    expect(told.map((row) => row.resource_id).sort()).toEqual(onDevice.map((action) => action.id).sort());

    // --- Verification closes the audit.
    for (const action of onDevice) {
      const verified = await world.request('POST', `${base}/corrective-actions/${action.id}/verify`, {
        token: world.actors.SUPER_ADMIN.accessToken,
        body: {},
      });
      expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    }
    const closed = (await world.request('GET', `${base}/audits/${auditId}`, { token: world.actors.SUPER_ADMIN.accessToken }))
      .body as Audit;
    expect(closed.status).toBe('CLOSED');

    // The device drops what is verified on its next catalogue.
    await replaceCatalogue(leader.database, (await leader.call('GET', `${base}/sync/catalogue`)).body as SyncCatalogue);
    expect((await listLocalCorrectiveActions(leader.database)).filter((action) => action.auditId === auditId)).toEqual([]);
  });
});
