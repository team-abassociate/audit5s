import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  HEADER_IDEMPOTENCY_KEY,
  type CorrectiveActionDetail,
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
 *   * **Live capture required**, server-side, not merely in the page.
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

  it('accepts Option A with a live after-photo, and refuses one that is not live', async () => {
    const { links } = await reportWithLinks({ nonconformities: 1 });
    const secret = links[0]!.secret;
    const submissionId = randomUUID();

    const notLive = await world.request(
      'POST',
      `${base}/public/corrective-actions/${secret}/upload-intent`,
      {
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        body: intentBody(randomUUID(), submissionId, links[0]!.correctiveActionId, false),
      },
    );
    // CA-2 and §10.4: the page offers no file picker, and the server says so too.
    expect(notLive.status).toBe(422);
    expect(JSON.stringify(notLive.body)).toMatch(/live/i);

    const evidenceId = randomUUID();
    const intent = await world.request(
      'POST',
      `${base}/public/corrective-actions/${secret}/upload-intent`,
      {
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        body: intentBody(evidenceId, submissionId, links[0]!.correctiveActionId, true),
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
