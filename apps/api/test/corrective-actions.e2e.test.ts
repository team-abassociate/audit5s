import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  HEADER_IDEMPOTENCY_KEY,
  type Audit,
  type CorrectiveAction,
  type CorrectiveActionDetail,
  type CorrectiveActionSubmission,
  type SyncBatchResponse,
  type SyncCatalogue,
} from '@audit5s/contracts';
import { captureEvidence, loginFromDevice, sha256Hex, startWorld, stopWorld, TINY_JPEG, type TestActor, type TestWorld } from './harness';
import { afterPhoto, completedWalkBy, submit, submitOptionA } from './corrective-fixtures';

/**
 * Corrective actions (§2.8, §5.7, §7.3, §8.8), through the real endpoints.
 *
 * The suite is built around the one scenario PART 14 names for this phase: five
 * nonconformities, three answered on Monday and two on Friday, and nothing about Friday's
 * write path able to touch Monday's work.
 */

let world: TestWorld;
const base = API_BASE_PATH;

const CONSULTANT_DEVICE = '01930000-0000-7000-8000-0000000ca001';
const LEADER_DEVICE = '01930000-0000-7000-8000-0000000ca002';

let consultantToken: string;
let leaderToken: string;
let superAdmin: string;
let secondLeader: TestActor;

beforeAll(async () => {
  world = await startWorld();
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, CONSULTANT_DEVICE);
  leaderToken = world.actors.ZONE_LEADER.accessToken;
  superAdmin = world.actors.SUPER_ADMIN.accessToken;
  // A Consultant may hold many Units: Unit B gives every out-of-scope case an action.
  await world.owner.query(
    `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
     VALUES ($1, $2, 'CONSULTANT', $1)`,
    [world.actors.CONSULTANT.userId, world.unitB],
  );
  secondLeader = await makeSecondLeader();
}, 180_000);

afterAll(async () => {
  await stopWorld(world);
});

/** A second Zone Leader of Unit A, assigned nothing — R-3b's "leader on leave" stand-in. */
async function makeSecondLeader(): Promise<TestActor> {
  const argon2 = await import('argon2');
  const { ARGON2_OPTIONS } = await import('../src/modules/auth/password.service');
  const { FIXTURE_PASSWORD } = await import('./harness');
  const { rows } = await world.owner.query(
    `INSERT INTO "user" (login_id, full_name, phone_e164, role, password_hash,
                         must_reset_password, status)
     VALUES ('ZA0199', 'Zed Standin', '+919000000199', 'ZONE_LEADER', $1, false, 'ACTIVE')
     RETURNING id`,
    [await argon2.hash(FIXTURE_PASSWORD, ARGON2_OPTIONS)],
  );
  await world.owner.query(
    `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
     VALUES ($1, $2, 'ZONE_LEADER', $1)`,
    [rows[0].id, world.unitA],
  );
  const login = await world.request('POST', `${base}/auth/login`, {
    body: { loginId: 'ZA0199', password: FIXTURE_PASSWORD },
  });
  const tokens = login.body as { accessToken: string; refreshToken: string };
  return {
    role: 'ZONE_LEADER',
    userId: rows[0].id as string,
    loginId: 'ZA0199',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    unitId: world.unitA,
  };
}

function walkBy(nonconformities: number, extra: { good?: number; withdrawn?: number; unitB?: boolean } = {}) {
  return completedWalkBy(world, {
    token: consultantToken,
    deviceId: CONSULTANT_DEVICE,
    unitId: extra.unitB ? world.unitB : world.unitA,
    zoneLeaderUserId: extra.unitB ? world.outOfScopeUserId : world.actors.ZONE_LEADER.userId,
    nonconformities,
    ...(extra.good !== undefined ? { good: extra.good } : {}),
    ...(extra.withdrawn !== undefined ? { withdrawn: extra.withdrawn } : {}),
  });
}

async function detail(actionId: string, token = superAdmin): Promise<CorrectiveActionDetail> {
  const response = await world.request('GET', `${base}/corrective-actions/${actionId}`, { token });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as CorrectiveActionDetail;
}

async function auditStatus(auditId: string): Promise<{ status: string; closedAt: string | null }> {
  const response = await world.request('GET', `${base}/audits/${auditId}`, { token: superAdmin });
  const audit = response.body as Audit;
  return { status: audit.status, closedAt: (audit as Audit & { closedAt?: string | null }).closedAt ?? null };
}

function verify(actionId: string, body: Record<string, unknown> = {}, token = superAdmin) {
  return world.request('POST', `${base}/corrective-actions/${actionId}/verify`, { token, body });
}

function reopen(actionId: string, reason = 'The label is still missing', token = superAdmin) {
  return world.request('POST', `${base}/corrective-actions/${actionId}/reopen`, { token, body: { reason } });
}

// ------------------------------------------------------------------ materialisation

describe('materialisation on AUDIT_COMPLETED (§2.8, §7.1)', () => {
  it('opens one action per nonconformity photo, routed to the Zone’s leader, due in seven days', async () => {
    const { audit, actions } = await walkBy(3, { good: 1 });

    expect(audit.status).toBe('CORRECTIVE_ACTION_OPEN');
    expect(actions).toHaveLength(3);
    for (const action of actions) {
      expect(action.status).toBe('OPEN');
      expect(action.assignedZoneLeaderUserId).toBe(world.actors.ZONE_LEADER.userId);
      expect(action.assignedZoneLeaderName).toBe('Zoe Leader');
      expect(action.auditType).toBe('WALK_BY');
      // A walk-by has no questionnaire, so its actions name no question (§5.7).
      expect(action.checklistQuestionId).toBeNull();
      const days = (Date.parse(action.dueAt!) - Date.parse(action.auditCompletedAt!)) / 86_400_000;
      expect(days).toBeCloseTo(7, 5);
    }
  });

  it('closes an audit that found nothing', async () => {
    const { audit, actions } = await walkBy(0, { good: 1 });
    expect(actions).toHaveLength(0);
    expect(audit.status).toBe('CLOSED');
  });

  it('raises nothing for a photo withdrawn before completion (E-4)', async () => {
    const { actions } = await walkBy(1, { withdrawn: 1 });
    expect(actions).toHaveLength(1);
  });

  it('raises nothing twice when the completion is replayed', async () => {
    const { auditId, actions } = await walkBy(2);
    const again = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    expect(again.status).toBe(200);
    expect((again.body as Audit).status).toBe('CORRECTIVE_ACTION_OPEN');
    const { rows } = await world.owner.query(
      `SELECT count(*)::int AS n FROM corrective_action WHERE audit_id = $1`,
      [auditId],
    );
    expect(rows[0].n).toBe(actions.length);
  });
});

// --------------------------------------------------- §7.3 — the named scenario

describe('the five-nonconformity partial-submission scenario (§7.3)', () => {
  it('keeps Monday’s three when Friday’s two arrive, and closes the audit on verification', async () => {
    const { auditId, actions } = await walkBy(5);
    expect(actions).toHaveLength(5);

    // Monday: three independent submissions — two Option A, one Option B.
    const monday = [
      await submitOptionA(world, leaderToken, actions[0]!),
      await submitOptionA(world, leaderToken, actions[1]!),
      await submit(world, leaderToken, actions[2]!.id, {
        option: 'NOT_POSSIBLE',
        explanation: 'The rack is owned by the landlord and cannot be moved',
      }),
    ];
    for (const response of monday) {
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect((response.body as CorrectiveActionSubmission).attemptNo).toBe(1);
    }

    const afterMonday = await Promise.all(actions.map((action) => detail(action.id)));
    expect(afterMonday.map((action) => action.status)).toEqual([
      'ACTION_SUBMITTED',
      'ACTION_SUBMITTED',
      'NOT_POSSIBLE',
      'OPEN',
      'OPEN',
    ]);
    // A submission is not a resolution (R-13): nothing is verified, so nothing is closed.
    expect((await auditStatus(auditId)).status).toBe('CORRECTIVE_ACTION_OPEN');

    // Friday: the other two. Nothing in their write path names items 1–3.
    expect((await submitOptionA(world, leaderToken, actions[3]!)).status).toBe(201);
    expect(
      (await submit(world, leaderToken, actions[4]!.id, { option: 'NOT_POSSIBLE', explanation: 'Awaiting a part' }))
        .status,
    ).toBe(201);

    const afterFriday = await Promise.all(actions.map((action) => detail(action.id)));
    // Monday's work is exactly as Monday left it.
    expect(afterFriday.slice(0, 3).map((action) => action.submissions)).toEqual(
      afterMonday.slice(0, 3).map((action) => action.submissions),
    );
    for (const action of afterFriday) {
      expect(action.submissions).toHaveLength(1);
    }

    // Verification moves the audit: some resolved → PARTIALLY_CLOSED; all → CLOSED.
    expect((await verify(actions[0]!.id)).status).toBe(200);
    expect((await auditStatus(auditId)).status).toBe('PARTIALLY_CLOSED');
    for (const action of actions.slice(1)) {
      expect((await verify(action.id)).status).toBe(200);
    }
    const closed = await auditStatus(auditId);
    expect(closed.status).toBe('CLOSED');

    // Accepting a NOT_POSSIBLE is how it ends (§7.3): VERIFIED, with the attempt reviewed.
    const accepted = await detail(actions[2]!.id);
    expect(accepted.status).toBe('VERIFIED');
    expect(accepted.resolvedAt).not.toBeNull();
    expect(accepted.submissions[0]!.reviewOutcome).toBe('VERIFIED');
  });
});

// ------------------------------------------------------------ reopen → resubmit

describe('reopen and resubmit (§7.3, CA-1)', () => {
  it('inserts attempt 2 and leaves attempt 1 exactly as it was', async () => {
    const { actions } = await walkBy(1);
    const action = actions[0]!;

    const first = await submitOptionA(world, leaderToken, action, 'First fix');
    expect(first.status).toBe(201);

    const reopened = await reopen(action.id);
    expect(reopened.status).toBe(200);
    const afterReopen = reopened.body as CorrectiveActionDetail;
    expect(afterReopen.status).toBe('REOPENED');
    expect(afterReopen.reopenCount).toBe(1);
    expect(afterReopen.submissions[0]!.reviewOutcome).toBe('REOPENED');
    expect(afterReopen.submissions[0]!.reviewComment).toBe('The label is still missing');

    const second = await submitOptionA(world, leaderToken, action, 'Second fix');
    expect(second.status).toBe(201);
    expect((second.body as CorrectiveActionSubmission).attemptNo).toBe(2);

    const history = (await detail(action.id)).submissions;
    expect(history.map((attempt) => attempt.attemptNo)).toEqual([1, 2]);
    expect(history[0]).toEqual({ ...afterReopen.submissions[0]! });
    expect(history[0]!.description).toBe('First fix');
    expect(history[1]!.description).toBe('Second fix');
  });

  it('walks a closed audit back open when its only action is reopened after verification', async () => {
    const { auditId, actions } = await walkBy(1);
    await submitOptionA(world, leaderToken, actions[0]!);
    await verify(actions[0]!.id);
    expect((await auditStatus(auditId)).status).toBe('CLOSED');

    // CLOSED → PARTIALLY_CLOSED → CORRECTIVE_ACTION_OPEN: §7.1 has no direct edge.
    expect((await reopen(actions[0]!.id)).status).toBe(200);
    expect((await auditStatus(auditId)).status).toBe('CORRECTIVE_ACTION_OPEN');
    expect((await detail(actions[0]!.id)).resolvedAt).toBeNull();
  });

  it('refuses a reopen without a reason and a verify of an OPEN action', async () => {
    const { actions } = await walkBy(1);
    const blank = await world.request('POST', `${base}/corrective-actions/${actions[0]!.id}/reopen`, {
      token: superAdmin,
      body: { reason: '' },
    });
    expect(blank.status).toBe(422);
    const early = await verify(actions[0]!.id);
    expect(early.status).toBe(409);
    expect((early.body as { code: string }).code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ------------------------------------------------------------------------- CA-2

describe('CA-2 and the submission contract (§8.8)', () => {
  it('refuses Option A without a photo — 422', async () => {
    const { actions } = await walkBy(1);
    const response = await submit(world, leaderToken, actions[0]!.id, {
      option: 'COMPLETED',
      submittedByName: 'Zoe Leader',
      description: 'Fixed',
    });
    expect(response.status).toBe(422);
  });

  it('refuses Option B without an explanation — 422', async () => {
    const { actions } = await walkBy(1);
    const response = await submit(world, leaderToken, actions[0]!.id, { option: 'NOT_POSSIBLE', explanation: ' ' });
    expect(response.status).toBe(422);
  });

  it('refuses a photo taken for another action', async () => {
    const { actions } = await walkBy(2);
    const submissionId = randomUUID();
    const photo = await afterPhoto(world, { token: leaderToken, action: actions[0]!, submissionId });
    const response = await submit(world, leaderToken, actions[1]!.id, {
      option: 'COMPLETED',
      submittedByName: 'Zoe Leader',
      description: 'Fixed',
      afterEvidenceId: photo,
    });
    expect(response.status).toBe(422);
  });

  it('refuses an after-photo that is not a live capture at the intent', async () => {
    const { actions } = await walkBy(1);
    await expect(
      afterPhoto(world, { token: leaderToken, action: actions[0]!, submissionId: randomUUID(), isLiveCapture: false }),
    ).rejects.toThrow(/live capture/);
  });

  it('asks for the upload to finish before an Option A is accepted', async () => {
    const { actions } = await walkBy(1);
    const photo = await afterPhoto(world, {
      token: leaderToken,
      action: actions[0]!,
      submissionId: randomUUID(),
      skipCommit: true,
    });
    const response = await submit(world, leaderToken, actions[0]!.id, {
      option: 'COMPLETED',
      submittedByName: 'Zoe Leader',
      description: 'Fixed',
      afterEvidenceId: photo,
    });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('EVIDENCE_NOT_UPLOADED');
  });

  it('requires an Idempotency-Key', async () => {
    const { actions } = await walkBy(1);
    const response = await world.request('POST', `${base}/corrective-actions/${actions[0]!.id}/submissions`, {
      token: leaderToken,
      body: { option: 'NOT_POSSIBLE', explanation: 'No budget this quarter' },
    });
    expect(response.status).toBe(422);
  });

  it('writes one row for a duplicate submission with the same Idempotency-Key', async () => {
    const { actions } = await walkBy(1);
    const key = randomUUID();
    const body = { option: 'NOT_POSSIBLE', explanation: 'No budget this quarter' };
    const first = await submit(world, leaderToken, actions[0]!.id, body, key);
    const second = await submit(world, leaderToken, actions[0]!.id, body, key);
    expect(first.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const { rows } = await world.owner.query(
      `SELECT count(*)::int AS n FROM corrective_action_submission WHERE corrective_action_id = $1`,
      [actions[0]!.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('refuses a submission to an action already awaiting review', async () => {
    const { actions } = await walkBy(1);
    await submit(world, leaderToken, actions[0]!.id, { option: 'NOT_POSSIBLE', explanation: 'No budget' });
    const again = await submit(world, leaderToken, actions[0]!.id, { option: 'NOT_POSSIBLE', explanation: 'Still none' });
    expect(again.status).toBe(409);
  });
});

// --------------------------------------------------------------- authorization

describe('PART 6 — corrective actions', () => {
  it('reads: SA everywhere, Consultant their audits, Coordinator and Zone Leader their Unit', async () => {
    const inA = (await walkBy(1)).actions[0]!;
    const inB = (await walkBy(1, { unitB: true })).actions[0]!;
    const status = async (token: string, id: string) =>
      (await world.request('GET', `${base}/corrective-actions/${id}`, { token })).status;

    expect(await status(superAdmin, inB.id)).toBe(200);
    expect(await status(consultantToken, inA.id)).toBe(200);
    expect(await status(world.actors.COORDINATOR.accessToken, inA.id)).toBe(200);
    expect(await status(world.actors.COORDINATOR.accessToken, inB.id)).toBe(404);
    expect(await status(leaderToken, inA.id)).toBe(200);
    expect(await status(leaderToken, inB.id)).toBe(404);
  });

  it('submits: a Zone Leader of the Unit, assigned or not (R-3b), or a Super Admin (R-18); nobody else', async () => {
    const { actions } = await walkBy(3);
    const body = { option: 'NOT_POSSIBLE', explanation: 'Structural — needs capex' };

    // Not the assignee, but a Zone Leader of the same Unit: accepted, deliberately.
    expect((await submit(world, secondLeader.accessToken, actions[0]!.id, body)).status).toBe(201);
    expect((await submit(world, world.outOfScopeActor.accessToken, actions[1]!.id, body)).status).toBe(404);
    // R-18: a Super Admin answers any action.
    expect((await submit(world, superAdmin, actions[2]!.id, body)).status).toBe(201);
    for (const role of ['CONSULTANT', 'COORDINATOR'] as const) {
      expect((await submit(world, world.actors[role].accessToken, actions[2]!.id, body)).status).toBe(403);
    }
  });

  it('verifies and reopens: Super Admin only', async () => {
    const { actions } = await walkBy(1);
    await submit(world, leaderToken, actions[0]!.id, { option: 'NOT_POSSIBLE', explanation: 'No budget' });
    for (const role of ['CONSULTANT', 'COORDINATOR', 'ZONE_LEADER'] as const) {
      expect((await verify(actions[0]!.id, {}, world.actors[role].accessToken)).status).toBe(403);
      expect((await reopen(actions[0]!.id, 'x', world.actors[role].accessToken)).status).toBe(403);
    }
  });

  it('reassigns: a Super Admin, or the Coordinator of the Unit, to a Zone Leader of it', async () => {
    const inA = (await walkBy(1)).actions[0]!;
    const inB = (await walkBy(1, { unitB: true })).actions[0]!;
    const reassign = (token: string, id: string, userId: string) =>
      world.request('POST', `${base}/corrective-actions/${id}/reassign`, {
        token,
        body: { zoneLeaderUserId: userId },
      });

    const moved = await reassign(world.actors.COORDINATOR.accessToken, inA.id, secondLeader.userId);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((moved.body as CorrectiveAction).assignedZoneLeaderUserId).toBe(secondLeader.userId);

    expect((await reassign(world.actors.COORDINATOR.accessToken, inB.id, world.outOfScopeUserId)).status).toBe(404);
    // A Zone Leader of another Unit is not a valid assignee, whoever asks.
    expect((await reassign(superAdmin, inA.id, world.outOfScopeUserId)).status).toBe(422);
    expect((await reassign(leaderToken, inA.id, secondLeader.userId)).status).toBe(403);
  });
});

// ---------------------------------------------------------------- concurrency

describe('§15.8 — a Zone Leader and a Super Admin acting at once', () => {
  it('lets exactly one of two concurrent verifications through', async () => {
    const { actions } = await walkBy(1);
    await submit(world, leaderToken, actions[0]!.id, { option: 'NOT_POSSIBLE', explanation: 'No budget' });
    const results = await Promise.all([verify(actions[0]!.id), verify(actions[0]!.id)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  });

  it('refuses a review against a stale version with VERSION_CONFLICT', async () => {
    const { actions } = await walkBy(1);
    const read = await detail(actions[0]!.id);
    await submit(world, leaderToken, actions[0]!.id, { option: 'NOT_POSSIBLE', explanation: 'No budget' });
    const stale = await verify(actions[0]!.id, { version: read.version });
    expect(stale.status).toBe(409);
    expect((stale.body as { code: string }).code).toBe('VERSION_CONFLICT');
  });
});

// ------------------------------------------------------------ the device path

describe('offline submission through the outbox (§9.2, §9.3)', () => {
  let deviceToken: string;

  beforeAll(async () => {
    deviceToken = await loginFromDevice(world, world.actors.ZONE_LEADER, LEADER_DEVICE);
  });

  function push(items: unknown[]) {
    return world.request('POST', `${base}/sync/batch`, {
      token: deviceToken,
      body: { batchId: randomUUID(), deviceId: LEADER_DEVICE, items },
    });
  }

  it('carries the Zone Leader’s open items in the catalogue, and none for a Consultant', async () => {
    const { actions } = await walkBy(1);
    const leader = await world.request('GET', `${base}/sync/catalogue`, { token: deviceToken });
    expect((leader.body as SyncCatalogue).correctiveActions.map((action) => action.id)).toContain(actions[0]!.id);
    const consultant = await world.request('GET', `${base}/sync/catalogue`, { token: consultantToken });
    expect((consultant.body as SyncCatalogue).correctiveActions).toEqual([]);
  });

  it('applies commit then submit in one batch, waits for an uncommitted photo, and never doubles', async () => {
    const { actions } = await walkBy(1);
    const action = actions[0]!;
    const submissionId = randomUUID();
    const evidenceId = randomUUID();

    // The media queue: intent and PUT, as the device's media pass does — no commit yet.
    await captureEvidence(world, {
      token: deviceToken,
      evidenceId,
      auditId: action.auditId,
      kind: 'CORRECTIVE_AFTER',
      correctiveActionId: action.id,
      correctiveActionSubmissionId: submissionId,
      deviceId: LEADER_DEVICE,
      skipCommit: true,
    });

    const submitItem = {
      outboxId: randomUUID(),
      entityType: 'corrective_action_submission',
      entityId: submissionId,
      operation: 'submit',
      payload: {
        correctiveActionId: action.id,
        option: 'COMPLETED',
        submittedByName: 'Zoe Leader',
        description: 'Fixed offline',
        afterEvidenceId: evidenceId,
      },
    };

    // Before the commit, the submission waits rather than failing.
    const early = await push([submitItem]);
    expect((early.body as SyncBatchResponse).results[0]!.status).toBe('RETRY_AFTER_PARENT');

    const both = await push([
      { ...submitItem, outboxId: randomUUID() },
      {
        outboxId: randomUUID(),
        entityType: 'evidence',
        entityId: evidenceId,
        operation: 'commit',
        payload: { checksumSha256: sha256Hex(TINY_JPEG) },
      },
    ]);
    const verdicts = (both.body as SyncBatchResponse).results;
    expect(verdicts.map((verdict) => verdict.status), JSON.stringify(verdicts)).toEqual(['ACCEPTED', 'ACCEPTED']);

    // A replay of the same attempt — a new batch, as a device that lost the response sends.
    const replay = await push([{ ...submitItem, outboxId: randomUUID() }]);
    expect((replay.body as SyncBatchResponse).results[0]!.status).toBe('ACCEPTED');

    const history = (await detail(action.id)).submissions;
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe(submissionId);
    expect(history[0]!.submittedVia).toBe('MOBILE');
  });

  it('lets the media worker thumbnail an after-photo on a completed audit', async () => {
    const { actions } = await walkBy(1);
    const submissionId = randomUUID();
    const evidenceId = await afterPhoto(world, { token: deviceToken, action: actions[0]!, submissionId, deviceId: LEADER_DEVICE });
    const { MediaWorker } = await import('../src/modules/evidence/media.worker');
    await world.app.get(MediaWorker).handle({ evidenceId, auditorUserId: world.actors.ZONE_LEADER.userId });
    const { rows } = await world.owner.query(
      `SELECT media_processed_at IS NOT NULL AS processed FROM evidence WHERE id = $1`,
      [evidenceId],
    );
    expect(rows[0].processed).toBe(true);
    void HEADER_IDEMPOTENCY_KEY;
  });
});
