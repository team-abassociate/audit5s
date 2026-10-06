import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  HEADER_IDEMPOTENCY_KEY,
  type CorrectiveActionDetail,
  type CorrectiveActionLink,
  type PublicCorrectiveAction,
  type ReportAccessToken,
  type ReportPayload,
  type ReportSnapshot,
} from '@audit5s/contracts';
import {
  loginFromDevice,
  sha256Hex,
  startWorld,
  stopWorld,
  TINY_JPEG,
  type TestWorld,
} from './harness';
import { completedWalkBy } from './corrective-fixtures';

/**
 * The public, signed-token surface (§8.8, §10.4) — the one surface a person outside the
 * organization touches, and therefore the one worth being paranoid about.
 *
 * What this suite pins, in the order the security table states it:
 *
 *   * **Expired, revoked, unknown and malformed all answer the same `410`.** Not 401, not
 *     403, not 404, and above all not four different answers — a surface that told a
 *     prober which of their guesses was closest would be enumerable.
 *   * **A single-item audience.** The link reaches one corrective action. There is no
 *     listing route, and a link cannot be pointed at a sibling.
 *   * **Not a session.** The token does not authorize the authenticated API.
 *   * **A gallery photo is accepted** (R-40), and recorded as not live.
 *   * **Every use recorded**, including the refused ones.
 */

let world: TestWorld;
const base = API_BASE_PATH;

const CONSULTANT_DEVICE = '01930000-0000-7000-8000-00000007e002';

let superAdmin: string;
let consultantToken: string;

beforeAll(async () => {
  world = await startWorld();
  superAdmin = world.actors.SUPER_ADMIN.accessToken;
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, CONSULTANT_DEVICE);
}, 180_000);

afterAll(async () => {
  await stopWorld(world);
});

/**
 * A completed walk-by, a generated report, and the raw links it minted.
 *
 * The secrets are taken from the **payload**, which is where they really live — the token
 * rows hold only hashes, so there is no other way to obtain one, and a test that could
 * read a secret back from the database would be testing a system with a hole in it.
 */
async function reportWithLinks(options: { nonconformities?: number } = {}) {
  const walkBy = await completedWalkBy(world, {
    token: consultantToken,
    deviceId: CONSULTANT_DEVICE,
    unitId: world.unitA,
    zoneLeaderUserId: world.actors.ZONE_LEADER.userId,
    nonconformities: options.nonconformities ?? 2,
    good: 1,
  });

  const snapshot = (
    await world.request('POST', `${base}/reports/generate`, {
      token: superAdmin,
      headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
      body: { kind: 'INITIAL_ZONE', auditZoneId: walkBy.auditZoneId },
    })
  ).body as ReportSnapshot;

  const payload = (
    await world.request('GET', `${base}/reports/${snapshot.id}/payload`, { token: superAdmin })
  ).body as ReportPayload;

  const links = payload.zones[0]!.nonconformities.map((item) => ({
    correctiveActionId: item.correctiveActionId,
    secret: item.correctiveActionUrl!.split('/ca/')[1]!,
  }));

  return { ...walkBy, snapshot, links };
}

const GONE_DETAIL = /new corrective-action link/i;

describe('GET /public/corrective-actions/{token}', () => {
  it('returns exactly one item, with a presigned before photo and no siblings', async () => {
    const { links, actions } = await reportWithLinks();
    const response = await world.request('GET', `${base}/public/corrective-actions/${links[0]!.secret}`);

    expect(response.status).toBe(200);
    const item = response.body as PublicCorrectiveAction;
    expect(item.correctiveActionId).toBe(links[0]!.correctiveActionId);
    expect(item.submittable).toBe(true);
    expect(item.unitName).not.toBe('');
    expect(item.auditorName).not.toBe('');
    expect(item.beforePhotoUrl).toContain('http');
    expect(item.issuedToName).not.toBeNull();

    // One item. Nothing in the response names the sibling finding.
    expect(JSON.stringify(item)).not.toContain(actions[1]!.id);
  }, 120_000);

  it('needs no bearer token at all — the link is the credential', async () => {
    const { links } = await reportWithLinks({ nonconformities: 1 });
    const response = await world.request(
      'GET',
      `${base}/public/corrective-actions/${links[0]!.secret}`,
      { token: null },
    );
    expect(response.status).toBe(200);
  }, 120_000);

  /** §10.4: "an invalid token returns the same 410 as an expired one". */
  it('answers 410 for an unknown link', async () => {
    const response = await world.request(
      'GET',
      `${base}/public/corrective-actions/${'a'.repeat(43)}`,
    );
    expect(response.status).toBe(410);
    expect((response.body as { code: string }).code).toBe('TOKEN_EXPIRED');
    expect((response.body as { detail: string }).detail).toMatch(GONE_DETAIL);
  }, 120_000);

  it('answers 410 for a malformed link, with the same body', async () => {
    const unknown = await world.request(
      'GET',
      `${base}/public/corrective-actions/${'a'.repeat(43)}`,
    );
    const malformed = await world.request('GET', `${base}/public/corrective-actions/not-a-token`);

    expect(malformed.status).toBe(410);
    // Byte-identical but for the request id: the two cases must be indistinguishable.
    expect(withoutRequestId(malformed.body)).toEqual(withoutRequestId(unknown.body));
  }, 120_000);

  it('answers 410 once the link has expired', async () => {
    const { links } = await reportWithLinks({ nonconformities: 1 });
    await expire(links[0]!.correctiveActionId);

    const response = await world.request(
      'GET',
      `${base}/public/corrective-actions/${links[0]!.secret}`,
    );
    expect(response.status).toBe(410);
    expect((response.body as { code: string }).code).toBe('TOKEN_EXPIRED');
  }, 120_000);

  it('answers 410 once the link has been revoked, and records who revoked it and why', async () => {
    const { links, snapshot } = await reportWithLinks({ nonconformities: 1 });

    const tokens = (
      await world.request('GET', `${base}/reports/${snapshot.id}/tokens`, { token: superAdmin })
    ).body as ReportAccessToken[];

    const revoked = await world.request(
      'POST',
      `${base}/reports/${snapshot.id}/tokens/${tokens[0]!.id}/revoke`,
      { token: superAdmin, body: { reason: 'Sent to the wrong person' } },
    );
    expect(revoked.status).toBe(200);
    expect((revoked.body as ReportAccessToken).revokedAt).not.toBeNull();
    expect((revoked.body as ReportAccessToken).active).toBe(false);

    const response = await world.request(
      'GET',
      `${base}/public/corrective-actions/${links[0]!.secret}`,
    );
    expect(response.status).toBe(410);

    const { rows } = await world.owner.query(
      `SELECT action, resource_type FROM audit_log
        WHERE action = 'report.token_revoked' AND resource_id = $1`,
      [tokens[0]!.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].resource_type).toBe('report_access_token');
  }, 120_000);

  it('records every use, including the ones it refused', async () => {
    const { links } = await reportWithLinks({ nonconformities: 1 });

    await world.request('GET', `${base}/public/corrective-actions/${links[0]!.secret}`);
    await world.request('GET', `${base}/public/corrective-actions/${links[0]!.secret}`);
    await world.owner.query(
      `UPDATE report_access_token SET revoked_at = now(), revoked_by_user_id = $2,
              revoke_reason = 'test'
        WHERE corrective_action_id = $1`,
      [links[0]!.correctiveActionId, world.actors.SUPER_ADMIN.userId],
    );
    await world.request('GET', `${base}/public/corrective-actions/${links[0]!.secret}`);

    const { rows } = await world.owner.query(
      `SELECT use_count, last_used_at FROM report_access_token WHERE corrective_action_id = $1`,
      [links[0]!.correctiveActionId],
    );
    // Three attempts, the third refused — a revoked link being tried is exactly the event
    // a Super Admin would want in the trail.
    expect(rows[0].use_count).toBe(3);
    expect(rows[0].last_used_at).not.toBeNull();
  }, 120_000);
});

describe('the link is not a session', () => {
  it('does not authorize the authenticated API', async () => {
    const { links } = await reportWithLinks({ nonconformities: 1 });

    // Presented as a bearer token, a link is simply not a JWT.
    const response = await world.request('GET', `${base}/corrective-actions`, {
      token: links[0]!.secret,
    });
    expect(response.status).toBe(401);
  }, 120_000);

  it('cannot be pointed at a sibling finding', async () => {
    const { links } = await reportWithLinks({ nonconformities: 2 });

    const first = (
      await world.request('GET', `${base}/public/corrective-actions/${links[0]!.secret}`)
    ).body as PublicCorrectiveAction;
    const second = (
      await world.request('GET', `${base}/public/corrective-actions/${links[1]!.secret}`)
    ).body as PublicCorrectiveAction;

    expect(first.correctiveActionId).not.toBe(second.correctiveActionId);
    // Each link answers for its own item and no other; there is no route that lists them.
    const listing = await world.request('GET', `${base}/public/corrective-actions`);
    expect(listing.status).toBe(404);
  }, 120_000);
});

describe('submitting through the link', () => {
  it('accepts Option B and moves the action, through the same domain service', async () => {
    const { links } = await reportWithLinks({ nonconformities: 1 });
    const secret = links[0]!.secret;

    const response = await world.request(
      'POST',
      `${base}/public/corrective-actions/${secret}/submissions`,
      {
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        // R-22: through a signed link the answerer may have no account, so the route
        // requires them to say who they are. Omitting it is the 422 this once asserted 201 for.
        body: {
          option: 'NOT_POSSIBLE',
          submittedByName: 'R. Deshmukh',
          explanation: 'Requires vendor approval; PO raised.',
        },
      },
    );

    expect(response.status).toBe(201);

    const detail = (
      await world.request('GET', `${base}/corrective-actions/${links[0]!.correctiveActionId}`, {
        token: superAdmin,
      })
    ).body as CorrectiveActionDetail;

    expect(detail.status).toBe('NOT_POSSIBLE');
    expect(detail.submissions.length).toBe(1);
    expect(detail.submissions[0]!.submittedVia).toBe('WEB_TOKEN');

    // §10.4's "auditable": the attempt names the link it arrived on.
    const { rows } = await world.owner.query(
      `SELECT access_token_id FROM corrective_action_submission WHERE id = $1`,
      [detail.submissions[0]!.id],
    );
    expect(rows[0].access_token_id).not.toBeNull();
  }, 120_000);

  it('accepts Option A on a finding with a photo from the gallery (R-40)', async () => {
    const { links } = await reportWithLinks({ nonconformities: 1 });
    const secret = links[0]!.secret;
    const submissionId = randomUUID();

    // Not a live capture: the page's *Choose from gallery*. A link in a PDF issued before
    // R-40 is the same link, so this is also what an old PDF's reader now gets.
    const evidenceId = randomUUID();
    const intent = await world.request(
      'POST',
      `${base}/public/corrective-actions/${secret}/upload-intent`,
      {
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        body: intentBody(evidenceId, submissionId, links[0]!.correctiveActionId, false),
      },
    );
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);

    const { uploadUrl } = intent.body as { uploadUrl: string };
    // Straight to the presigned URL, carrying no session — exactly as the page would.
    const put = await world.app.inject({
      method: 'PUT',
      url: uploadUrl.replace(/^https?:\/\/[^/]+/, ''),
      headers: { 'content-type': 'image/jpeg' },
      payload: TINY_JPEG,
    });
    expect(put.statusCode, put.body).toBe(200);

    // The commit is authenticated: it is not one of the two operations a link authorizes.
    const committed = await world.request('POST', `${base}/evidence/${evidenceId}/commit`, {
      token: world.actors.ZONE_LEADER.accessToken,
      headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
      body: { checksumSha256: sha256Hex(TINY_JPEG) },
    });
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);

    const submitted = await world.request(
      'POST',
      `${base}/public/corrective-actions/${secret}/submissions`,
      {
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        body: {
          option: 'COMPLETED',
          id: submissionId,
          submittedByName: 'R. Deshmukh',
          description: 'Spillage cleared and a drip tray fitted.',
          afterEvidenceId: evidenceId,
        },
      },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

    // The record says honestly where the photograph came from.
    const { rows } = await world.owner.query(`SELECT is_live_capture FROM evidence WHERE id = $1`, [
      evidenceId,
    ]);
    expect(rows[0].is_live_capture).toBe(false);
  }, 180_000);

  it('refuses to submit through an expired link, as it refuses to read through one', async () => {
    const { links } = await reportWithLinks({ nonconformities: 1 });
    await expire(links[0]!.correctiveActionId);

    const response = await world.request(
      'POST',
      `${base}/public/corrective-actions/${links[0]!.secret}/submissions`,
      {
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        body: { option: 'NOT_POSSIBLE', explanation: 'Too late.' },
      },
    );
    expect(response.status).toBe(410);
  }, 120_000);
});

function intentBody(
  evidenceId: string,
  submissionId: string,
  correctiveActionId: string,
  isLiveCapture: boolean,
) {
  return {
    id: evidenceId,
    kind: 'CORRECTIVE_AFTER',
    // Overwritten from the token server-side; sent here as a client would.
    auditId: randomUUID(),
    correctiveActionId,
    correctiveActionSubmissionId: submissionId,
    contentType: 'image/jpeg',
    byteSize: TINY_JPEG.byteLength,
    checksumSha256: sha256Hex(TINY_JPEG),
    capturedAt: new Date().toISOString(),
    isLiveCapture,
  };
}

/**
 * Moves one link past its expiry.
 *
 * `expires_at` is fixed at minting by a trigger — deliberately: §10.4 makes the expiry a
 * property of the link, and the remedy for a link that has run out is to mint another.
 * That leaves a test no way to reach the expired case except to wait thirty days, so the
 * session's replication role is lowered for exactly this one statement. It is simulating
 * the passage of time, not exercising a path the application has.
 */
async function expire(correctiveActionId: string): Promise<void> {
  await world.owner.query(
    `ALTER TABLE report_access_token DISABLE TRIGGER report_access_token_audience_fixed`,
  );
  try {
    await world.owner.query(
      `UPDATE report_access_token SET expires_at = now() - interval '1 day'
        WHERE corrective_action_id = $1`,
      [correctiveActionId],
    );
  } finally {
    await world.owner.query(
      `ALTER TABLE report_access_token ENABLE TRIGGER report_access_token_audience_fixed`,
    );
  }
}

function withoutRequestId(body: unknown): unknown {
  const { requestId, ...rest } = body as Record<string, unknown>;
  void requestId;
  return rest;
}

describe('POST /corrective-actions/{id}/link — one more link, the printed one kept (CA9)', () => {
  const mint = (actionId: string, key: string | null = randomUUID(), token = superAdmin) =>
    world.request('POST', `${base}/corrective-actions/${actionId}/link`, {
      token,
      headers: key ? { [HEADER_IDEMPOTENCY_KEY]: key } : {},
    });
  const open = (secret: string) => world.request('GET', `${base}/public/corrective-actions/${secret}`);
  const linksOf = async (snapshotId: string, actionId: string) =>
    (
      (await world.request('GET', `${base}/reports/${snapshotId}/tokens`, { token: superAdmin }))
        .body as ReportAccessToken[]
    ).filter((link) => link.correctiveActionId === actionId);

  it('mints a working link on the report, keeps the printed one working, and logs it', async () => {
    const { links, snapshot } = await reportWithLinks({ nonconformities: 1 });
    const printed = links[0]!;
    const key = randomUUID();

    const response = await mint(printed.correctiveActionId, key);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const made = response.body as CorrectiveActionLink;
    expect(made.snapshotId).toBe(snapshot.id);
    const secret = made.url!.split('/ca/')[1]!;
    expect(secret).not.toBe(printed.secret);

    expect(((await open(secret)).body as PublicCorrectiveAction).correctiveActionId).toBe(printed.correctiveActionId);
    expect((await open(printed.secret)).status).toBe(200);
    expect((await linksOf(snapshot.id, printed.correctiveActionId)).map((l) => l.active)).toEqual([true, true]);

    // A retry under the same key mints nothing, and the secret was never stored for it.
    const replay = await mint(printed.correctiveActionId, key);
    expect(replay.body).toEqual({ ...made, url: null });
    expect(await linksOf(snapshot.id, printed.correctiveActionId)).toHaveLength(2);
    const { rows } = await world.owner.query(`SELECT response_body::text AS body FROM idempotency_key WHERE key = $1`, [key]);
    expect(rows[0].body).not.toContain(secret);

    const log = await world.request('GET', `${base}/audit-logs?action=report.token_minted&limit=200`, { token: superAdmin });
    const entry = (log.body as { data: Array<{ resourceId: string; after: Record<string, unknown> }> }).data.find(
      (e) => e.resourceId === made.tokenId,
    );
    expect(entry?.after).toEqual({ correctiveActionId: printed.correctiveActionId, snapshotId: snapshot.id });

    // Revoked on the Reports page like any link; the printed one is untouched by that.
    const revoke = await world.request('POST', `${base}/reports/${snapshot.id}/tokens/${made.tokenId}/revoke`, {
      token: superAdmin,
      body: { reason: 'Sent to the wrong person' },
    });
    expect(revoke.status).toBe(200);
    expect((await open(secret)).status).toBe(410);
    expect((await open(printed.secret)).status).toBe(200);
  }, 120_000);

  it('needs an Idempotency-Key, and a Super Admin or the Coordinator', async () => {
    const { links } = await reportWithLinks({ nonconformities: 1 });
    const actionId = links[0]!.correctiveActionId;
    expect((await mint(actionId, null)).status).toBe(422);
    for (const role of ['CONSULTANT', 'ZONE_LEADER'] as const) {
      const token = role === 'CONSULTANT' ? consultantToken : world.actors[role].accessToken;
      expect((await mint(actionId, randomUUID(), token)).status, role).toBe(403);
    }
  }, 120_000);

  it('lets a Coordinator make a working link for their own Unit, and no more (R-47)', async () => {
    const { links, snapshot } = await reportWithLinks({ nonconformities: 1 });
    const actionId = links[0]!.correctiveActionId;
    const coordinator = world.actors.COORDINATOR;

    const response = await mint(actionId, randomUUID(), coordinator.accessToken);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const made = response.body as CorrectiveActionLink;
    expect(made.snapshotId).toBe(snapshot.id);
    expect((await open(made.url!.split('/ca/')[1]!)).status).toBe(200);
    expect((await linksOf(snapshot.id, actionId)).map((l) => l.active)).toEqual([true, true]);
    const logged = await world.owner.query(
      `SELECT actor_user_id FROM audit_log WHERE action = 'report.token_minted' AND resource_id = $1`,
      [made.tokenId],
    );
    expect(logged.rows).toEqual([{ actor_user_id: coordinator.userId }]);

    // Links only: the report, its link list and revoking stay the Super Admin's (R-39).
    for (const path of [`/reports/${snapshot.id}`, `/reports/${snapshot.id}/tokens`]) {
      expect((await world.request('GET', `${base}${path}`, { token: coordinator.accessToken })).status, path).toBe(403);
    }
    const revoke = await world.request('POST', `${base}/reports/${snapshot.id}/tokens/${made.tokenId}/revoke`, {
      token: coordinator.accessToken,
      body: { reason: 'Not mine to revoke' },
    });
    expect(revoke.status).toBe(403);

    // With no Zone Leader account to act as, the link acts as the report's Super Admin, not
    // as the Coordinator who made it: a Coordinator answers no finding (R-22, R-47).
    const leader = world.actors.ZONE_LEADER.userId;
    await world.owner.query(`UPDATE "user" SET status = 'DISABLED' WHERE id = $1`, [leader]);
    try {
      expect((await open(made.url!.split('/ca/')[1]!)).status).toBe(200);
    } finally {
      await world.owner.query(`UPDATE "user" SET status = 'ACTIVE' WHERE id = $1`, [leader]);
    }

    // Another Unit's action is not there at all.
    await world.owner.query(`UPDATE unit_membership SET unit_id = $1 WHERE user_id = $2`, [world.unitB, coordinator.userId]);
    try {
      expect((await mint(actionId, randomUUID(), coordinator.accessToken)).status).toBe(404);
    } finally {
      await world.owner.query(`UPDATE unit_membership SET unit_id = $1 WHERE user_id = $2`, [world.unitA, coordinator.userId]);
    }
  }, 120_000);

  it('keeps no link, and revokes none, when its log entry cannot be written', async () => {
    const { links, snapshot } = await reportWithLinks({ nonconformities: 1 });
    const actionId = links[0]!.correctiveActionId;
    const printed = (await linksOf(snapshot.id, actionId))[0]!;

    await world.owner.query(`
      CREATE FUNCTION test_refuse_token_log() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action IN ('report.token_minted', 'report.token_revoked') THEN
          RAISE EXCEPTION 'audit_log refused for the test';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_refuse_token_log BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION test_refuse_token_log();`);
    try {
      expect((await mint(actionId)).status).toBe(500);
      const revoke = await world.request('POST', `${base}/reports/${snapshot.id}/tokens/${printed.id}/revoke`, {
        token: superAdmin,
        body: { reason: 'Sent to the wrong person' },
      });
      expect(revoke.status).toBe(500);
    } finally {
      await world.owner.query(`
        DROP TRIGGER test_refuse_token_log ON audit_log;
        DROP FUNCTION test_refuse_token_log();`);
    }

    expect((await linksOf(snapshot.id, actionId)).map((l) => [l.id, l.active])).toEqual([[printed.id, true]]);
    expect((await open(links[0]!.secret)).status).toBe(200);
  }, 120_000);

  it('refuses a closed item, and one no report has printed a link to', async () => {
    const { links } = await reportWithLinks({ nonconformities: 1 });
    await world.owner.query(`UPDATE corrective_action SET status = 'VERIFIED', resolved_at = now() WHERE id = $1`, [
      links[0]!.correctiveActionId,
    ]);
    expect((await mint(links[0]!.correctiveActionId)).status).toBe(409);

    const unprinted = await completedWalkBy(world, {
      token: consultantToken,
      deviceId: CONSULTANT_DEVICE,
      unitId: world.unitA,
      zoneLeaderUserId: world.actors.ZONE_LEADER.userId,
      nonconformities: 1,
    });
    const refused = await mint(unprinted.actions[0]!.id);
    expect(refused.status).toBe(409);
    expect((refused.body as { detail: string }).detail).toMatch(/Generate its Zone report/);
    expect((await mint(randomUUID())).status).toBe(404);
  }, 120_000);
});
