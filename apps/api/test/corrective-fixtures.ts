import { randomUUID } from 'node:crypto';
import { API_BASE_PATH, HEADER_IDEMPOTENCY_KEY, type Audit, type CorrectiveAction, type Page } from '@audit5s/contracts';
import type { DomainEventJob } from '../src/infrastructure/queue/domain-events';
import type { NotificationWorker } from '../src/modules/notifications/notification.worker';
import { captureEvidence, type TestWorld } from './harness';

/**
 * Fixtures for the Phase 6 suites: a completed walk-by whose photographs raise however
 * many corrective actions a test needs, built through the real endpoints — a walk-by is the
 * shortest honest path to a nonconformity, because the auditor classifies each photo (§2.7).
 */

const base = API_BASE_PATH;
let zoneCounter = 100;

export async function makeZone(
  world: TestWorld,
  unitId: string,
  zoneLeaderUserId: string | null,
): Promise<string> {
  zoneCounter += 1;
  const { rows } = await world.owner.query(
    `INSERT INTO zone (unit_id, code, name, zone_leader_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [unitId, `Z-${zoneCounter}`, `Line ${zoneCounter}`, zoneLeaderUserId],
  );
  return rows[0].id as string;
}

/**
 * A walk-by over one Zone, `nonconformities` NONCONFORMITY photos and `good` GOOD ones,
 * completed — which materialises the actions (§7.1). Returns them in open order.
 */
export async function completedWalkBy(
  world: TestWorld,
  options: {
    token: string;
    deviceId: string;
    unitId: string;
    zoneLeaderUserId: string | null;
    nonconformities: number;
    good?: number;
    /** Photos soft-deleted before completion: they raise nothing (E-4). */
    withdrawn?: number;
    /** The assignment this walk-by fulfils — how a team audit's share is linked. */
    assignmentId?: string;
  },
): Promise<{
  auditId: string;
  auditZoneId: string;
  /** The live Zone this walk-by covered — what a summary report's selection names. */
  zoneId: string;
  audit: Audit;
  actions: CorrectiveAction[];
}> {
  const auditId = randomUUID();
  const headers = { 'x-device-id': options.deviceId };

  const created = await world.request('POST', `${base}/audits`, {
    token: options.token,
    headers,
    body: {
      id: auditId,
      auditType: 'WALK_BY',
      unitId: options.unitId,
      deviceId: options.deviceId,
      ...(options.assignmentId ? { assignmentId: options.assignmentId } : {}),
    },
  });
  if (created.status !== 201) throw new Error(`create: ${JSON.stringify(created.body)}`);

  await captureEvidence(world, {
    token: options.token,
    evidenceId: randomUUID(),
    auditId,
    kind: 'AUDITOR_SELFIE',
    deviceId: options.deviceId,
  });
  const started = await world.request('POST', `${base}/audits/${auditId}/start`, {
    token: options.token,
    headers,
    body: { deviceId: options.deviceId },
  });
  if (started.status !== 200) throw new Error(`start: ${JSON.stringify(started.body)}`);

  const zoneId = await makeZone(world, options.unitId, options.zoneLeaderUserId);
  const auditZoneId = randomUUID();
  const zone = await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
    token: options.token,
    headers,
    body: { zoneId, sequenceNo: 1 },
  });
  if (zone.status !== 200) throw new Error(`zone: ${JSON.stringify(zone.body)}`);

  const photo = (classification: 'GOOD' | 'NONCONFORMITY') =>
    captureEvidence(world, {
      token: options.token,
      evidenceId: randomUUID(),
      auditId,
      auditZoneId,
      kind: 'WALK_BY_PHOTO',
      classification,
      deviceId: options.deviceId,
    });

  for (let i = 0; i < options.nonconformities; i += 1) await photo('NONCONFORMITY');
  for (let i = 0; i < (options.good ?? 0); i += 1) await photo('GOOD');
  for (let i = 0; i < (options.withdrawn ?? 0); i += 1) {
    const withdrawn = await photo('NONCONFORMITY');
    await world.request('DELETE', `${base}/evidence/${withdrawn.evidenceId}`, {
      token: options.token,
      headers,
    });
  }

  const finished = await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
    token: options.token,
    headers,
    body: {},
  });
  if (finished.status !== 200) throw new Error(`zone complete: ${JSON.stringify(finished.body)}`);

  const completed = await world.request('POST', `${base}/audits/${auditId}/complete`, {
    token: options.token,
    headers,
    body: {},
  });
  if (completed.status !== 200) throw new Error(`complete: ${JSON.stringify(completed.body)}`);

  const listed = await world.request('GET', `${base}/corrective-actions?auditId=${auditId}`, {
    token: world.actors.SUPER_ADMIN.accessToken,
  });
  return {
    auditId,
    auditZoneId,
    zoneId,
    audit: completed.body as Audit,
    actions: (listed.body as Page<CorrectiveAction>).data,
  };
}

/** A live after-photo for an attempt the caller minted, uploaded and committed. */
export async function afterPhoto(
  world: TestWorld,
  options: {
    token: string;
    action: Pick<CorrectiveAction, 'id' | 'auditId'>;
    submissionId: string;
    deviceId?: string;
    isLiveCapture?: boolean;
    skipCommit?: boolean;
  },
): Promise<string> {
  const evidenceId = randomUUID();
  await captureEvidence(world, {
    token: options.token,
    evidenceId,
    auditId: options.action.auditId,
    kind: 'CORRECTIVE_AFTER',
    correctiveActionId: options.action.id,
    correctiveActionSubmissionId: options.submissionId,
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
    ...(options.isLiveCapture !== undefined ? { isLiveCapture: options.isLiveCapture } : {}),
    ...(options.skipCommit ? { skipCommit: true } : {}),
  });
  return evidenceId;
}

/** `POST /corrective-actions/{id}/submissions`, with a fresh Idempotency-Key unless given. */
export function submit(
  world: TestWorld,
  token: string,
  actionId: string,
  body: Record<string, unknown>,
  key: string = randomUUID(),
) {
  return world.request('POST', `${base}/corrective-actions/${actionId}/submissions`, {
    token,
    headers: { [HEADER_IDEMPOTENCY_KEY]: key },
    body,
  });
}

/** Option A end to end: mint the attempt id, take the photo, submit. */
export async function submitOptionA(
  world: TestWorld,
  token: string,
  action: Pick<CorrectiveAction, 'id' | 'auditId'>,
  description = 'Rack relabelled and the aisle cleared',
) {
  const submissionId = randomUUID();
  const afterEvidenceId = await afterPhoto(world, { token, action, submissionId });
  return submit(world, token, action.id, {
    option: 'COMPLETED',
    submittedByName: 'Zoe Leader',
    description,
    afterEvidenceId,
  });
}

/**
 * pg-boss's tables outlive `truncateAll`, so a suite that drains the queue first forgets
 * the jobs earlier suites left — their Units and users no longer exist. The suites run one
 * file at a time (`fileParallelism: false`), so nothing else is reading the queue.
 */
export async function forgetQueuedNotifications(world: TestWorld): Promise<void> {
  await world.owner.query(`DELETE FROM pgboss.job WHERE name = 'notification.send'`);
}

/**
 * Runs every queued `notification.send` job through the worker, the way `worker-general`
 * would. The API process in these suites registers no workers, so jobs wait in pg-boss's
 * table until a test hands them over. The worker is idempotent, so a job seen twice is
 * harmless; `seen` keeps the suites fast.
 */
export async function drainNotifications(
  world: TestWorld,
  worker: NotificationWorker,
  seen: Set<string> = new Set(),
): Promise<DomainEventJob[]> {
  const { rows } = await world.owner.query(
    `SELECT id, data FROM pgboss.job WHERE name = 'notification.send' ORDER BY created_on`,
  );
  const handled: DomainEventJob[] = [];
  for (const row of rows as Array<{ id: string; data: DomainEventJob }>) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    await worker.handle(row.data);
    handled.push(row.data);
  }
  return handled;
}
