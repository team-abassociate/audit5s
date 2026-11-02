import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  HEADER_IDEMPOTENCY_KEY,
  type CorrectiveActionDetail,
  type PublicCorrectiveAction,
  type ReportPayload,
  type ReportSnapshot,
  type SyncCatalogue,
} from '@audit5s/contracts';
import { loginFromDevice, sha256Hex, startWorld, stopWorld, TINY_JPEG, type TestWorld } from './harness';
import { completedWalkBy } from './corrective-fixtures';

/**
 * R-38 — overall corrective-action suggestions, through the real endpoints.
 *
 * The auditor writes them for the Zone as a whole; completing the audit turns each into a
 * corrective action with its own link in the report; the person holding that link answers
 * it in words, with a photograph from the camera or the gallery only if they have one.
 */

let world: TestWorld;
const base = API_BASE_PATH;

const CONSULTANT_DEVICE = '01930000-0000-7000-8000-0000000038a1';

let superAdmin: string;
let consultantToken: string;

const SUGGESTIONS = [
  'Find the source of the oil smell near the press pit and ventilate the bay',
  'Start a daily five-minute end-of-shift clean-up with a sign-off sheet',
];

beforeAll(async () => {
  world = await startWorld();
  superAdmin = world.actors.SUPER_ADMIN.accessToken;
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, CONSULTANT_DEVICE);
}, 180_000);

afterAll(async () => {
  await stopWorld(world);
});

function walkBy(overallActionSuggestions?: string[]) {
  return completedWalkBy(world, {
    token: consultantToken,
    deviceId: CONSULTANT_DEVICE,
    unitId: world.unitA,
    zoneLeaderUserId: world.actors.ZONE_LEADER.userId,
    nonconformities: 1,
    good: 1,
    ...(overallActionSuggestions ? { overallActionSuggestions } : {}),
  });
}

async function generate(auditZoneId: string, kind: 'INITIAL_ZONE' | 'AFTER_EVIDENCE_ZONE' = 'INITIAL_ZONE') {
  const snapshot = (
    await world.request('POST', `${base}/reports/generate`, {
      token: superAdmin,
      headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
      body: { kind, auditZoneId },
    })
  ).body as ReportSnapshot;
  const payload = (
    await world.request('GET', `${base}/reports/${snapshot.id}/payload`, { token: superAdmin })
  ).body as ReportPayload;
  return { snapshot, payload };
}

function secretOf(url: string | null): string {
  expect(url).not.toBeNull();
  return url!.split('/ca/')[1]!;
}

describe('completing a Zone with overall suggestions', () => {
  it('raises one corrective action per suggestion, beside the finding, routed the same way', async () => {
    const { actions } = await walkBy(SUGGESTIONS);

    const findings = actions.filter((action) => action.evidenceId !== null);
    const overall = actions
      .filter((action) => action.evidenceId === null)
      .sort((a, b) => a.suggestionNo! - b.suggestionNo!);

    expect(findings).toHaveLength(1);
    expect(overall.map((action) => [action.suggestionNo, action.suggestion])).toEqual([
      [1, SUGGESTIONS[0]],
      [2, SUGGESTIONS[1]],
    ]);
    for (const action of overall) {
      expect(action.status).toBe('OPEN');
      expect(action.assignedZoneLeaderUserId).toBe(world.actors.ZONE_LEADER.userId);
      expect(action.dueAt).toBe(findings[0]!.dueAt);
    }
  }, 120_000);

  it('is optional: a Zone with none raises only its findings', async () => {
    const { actions } = await walkBy([]);
    expect(actions.every((action) => action.evidenceId !== null)).toBe(true);
    expect(actions).toHaveLength(1);
  }, 120_000);

  it('refuses a list past the limit before anything is written', async () => {
    // The auditor's own audit, so the guards admit the request and the body is what fails.
    const { auditId, auditZoneId, zoneId } = await walkBy();
    const tooMany = Array.from({ length: 21 }, (_, index) => `Suggestion ${index + 1}`);
    const response = await world.request(
      'PUT',
      `${base}/audits/${auditId}/zones/${auditZoneId}`,
      {
        token: consultantToken,
        headers: { 'x-device-id': CONSULTANT_DEVICE },
        body: { zoneId, sequenceNo: 1, overallActionSuggestions: tooMany },
      },
    );
    expect(response.status).toBe(422);
  }, 120_000);
});

describe('the device catalogue', () => {
  it('carries overall actions only to a device that says it can store them', async () => {
    const { auditId } = await walkBy(SUGGESTIONS);
    const leader = world.actors.ZONE_LEADER.accessToken;
    const mine = (catalogue: SyncCatalogue) =>
      catalogue.correctiveActions.filter((action) => action.auditId === auditId);

    // An app built before R-38 cannot hold a row with no before photo.
    const old = (await world.request('GET', `${base}/sync/catalogue`, { token: leader }))
      .body as SyncCatalogue;
    expect(mine(old).every((action) => action.evidenceId !== null)).toBe(true);
    expect(mine(old)).toHaveLength(1);

    const current = (
      await world.request('GET', `${base}/sync/catalogue?overallActions=true`, { token: leader })
    ).body as SyncCatalogue;
    expect(mine(current)).toHaveLength(1 + SUGGESTIONS.length);
    expect(current.catalogueVersion).not.toBe(old.catalogueVersion);
  }, 120_000);
});

describe('the report and the link', () => {
  it('prints each suggestion with its own link, and leaves the findings as they were', async () => {
    const { auditZoneId } = await walkBy(SUGGESTIONS);
    const { payload } = await generate(auditZoneId);
    const zone = payload.zones[0]!;

    expect(zone.nonconformities).toHaveLength(1);
    expect(zone.overallActions.map((action) => action.suggestion)).toEqual(SUGGESTIONS);
    for (const action of zone.overallActions) {
      expect(action.correctiveActionUrl).toContain('/ca/');
      expect(action.outcome).toBeNull();
    }
  }, 120_000);

  it('opens on the suggestion, with no before photo', async () => {
    const { auditZoneId } = await walkBy(SUGGESTIONS);
    const { payload } = await generate(auditZoneId);
    const secret = secretOf(payload.zones[0]!.overallActions[0]!.correctiveActionUrl);

    const response = await world.request('GET', `${base}/public/corrective-actions/${secret}`);
    expect(response.status).toBe(200);
    const item = response.body as PublicCorrectiveAction;
    expect(item.suggestion).toBe(SUGGESTIONS[0]);
    expect(item.beforePhotoUrl).toBeNull();
    expect(item.submittable).toBe(true);
  }, 120_000);

  it('is answered in words alone, closes, and the regenerated report carries the answer', async () => {
    const { auditZoneId } = await walkBy(SUGGESTIONS);
    const { payload } = await generate(auditZoneId);
    const target = payload.zones[0]!.overallActions[0]!;

    const submitted = await world.request(
      'POST',
      `${base}/public/corrective-actions/${secretOf(target.correctiveActionUrl)}/submissions`,
      {
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        body: {
          option: 'COMPLETED',
          id: randomUUID(),
          submittedByName: 'R. Deshmukh',
          description: 'Sealed the leaking drain; exhaust fan in bay 2 repaired.',
        },
      },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

    const detail = (
      await world.request('GET', `${base}/corrective-actions/${target.correctiveActionId}`, {
        token: superAdmin,
      })
    ).body as CorrectiveActionDetail;
    // R-23: an answer that says what was done closes the item; a Super Admin may reopen it.
    expect(detail.status).toBe('VERIFIED');
    expect(detail.submissions.at(-1)?.afterEvidenceId).toBeNull();

    // The edition is the requester's choice: an answered Zone still issues its initial report.
    expect((await generate(auditZoneId)).payload.kind).toBe('INITIAL_ZONE');
    const regenerated = await generate(auditZoneId, 'AFTER_EVIDENCE_ZONE');
    expect(regenerated.payload.kind).toBe('AFTER_EVIDENCE_ZONE');
    const answered = regenerated.payload.zones[0]!.overallActions.find(
      (action) => action.correctiveActionId === target.correctiveActionId,
    )!;
    expect(answered.outcome).toMatchObject({
      option: 'COMPLETED',
      description: 'Sealed the leaking drain; exhaust fan in bay 2 repaired.',
      afterPhoto: null,
      verified: true,
    });
  }, 120_000);

  it('takes a photograph from the gallery for a suggestion, and records it as not live', async () => {
    const { auditZoneId } = await walkBy(SUGGESTIONS);
    const { payload } = await generate(auditZoneId);
    const target = payload.zones[0]!.overallActions[1]!;
    const secret = secretOf(target.correctiveActionUrl);
    const submissionId = randomUUID();
    const evidenceId = randomUUID();

    const intent = await world.request(
      'POST',
      `${base}/public/corrective-actions/${secret}/upload-intent`,
      {
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        body: {
          id: evidenceId,
          kind: 'CORRECTIVE_AFTER',
          auditId: randomUUID(),
          correctiveActionId: target.correctiveActionId,
          correctiveActionSubmissionId: submissionId,
          contentType: 'image/jpeg',
          byteSize: TINY_JPEG.byteLength,
          checksumSha256: sha256Hex(TINY_JPEG),
          capturedAt: new Date().toISOString(),
          isLiveCapture: false,
        },
      },
    );
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);

    const { uploadUrl } = intent.body as { uploadUrl: string };
    const put = await world.app.inject({
      method: 'PUT',
      url: uploadUrl.replace(/^https?:\/\/[^/]+/, ''),
      headers: { 'content-type': 'image/jpeg' },
      payload: TINY_JPEG,
    });
    expect(put.statusCode, put.body).toBe(200);

    const submitted = await world.request(
      'POST',
      `${base}/public/corrective-actions/${secret}/submissions`,
      {
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        body: {
          option: 'COMPLETED',
          id: submissionId,
          submittedByName: 'R. Deshmukh',
          description: 'Clean-up sheet posted at the bay entrance.',
          afterEvidenceId: evidenceId,
        },
      },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

    const { rows } = await world.owner.query(
      `SELECT is_live_capture FROM evidence WHERE id = $1`,
      [evidenceId],
    );
    expect(rows[0].is_live_capture).toBe(false);
  }, 120_000);

  it('still refuses a finding answered without its after-photo', async () => {
    const { auditZoneId } = await walkBy(SUGGESTIONS);
    const { payload } = await generate(auditZoneId);
    const finding = payload.zones[0]!.nonconformities[0]!;

    const submitted = await world.request(
      'POST',
      `${base}/public/corrective-actions/${secretOf(finding.correctiveActionUrl)}/submissions`,
      {
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        body: {
          option: 'COMPLETED',
          id: randomUUID(),
          submittedByName: 'R. Deshmukh',
          description: 'Cleaned.',
        },
      },
    );
    expect(submitted.status).toBe(422);
    expect(JSON.stringify(submitted.body)).toMatch(/after-photo/);
  }, 120_000);
});
