import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  HEADER_IDEMPOTENCY_KEY,
  type CorrectiveActionDetail,
  type Page,
  type PublicCorrectiveAction,
  type ReportDownloadUrl,
  type ReportPayload,
  type ReportSnapshot,
  type UploadIntentResponse,
} from '@audit5s/contracts';
import { ReportRenderer } from '../src/modules/reports/report-renderer';
import { ReportWorker } from '../src/modules/reports/report.worker';
import { renderReportHtml } from '../src/modules/reports/templates';
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
 * Phase 7 acceptance, literally:
 *
 * > Super Admin generates an Initial Zone Report matching the required layout; a Zone
 * > Leader opens the link on a phone, captures a live after-photo and submits; Super Admin
 * > verifies and regenerates an After-Evidence report as version 2 while version 1 stays
 * > downloadable and unchanged.
 *
 * Driven end to end through the real endpoints and the real renderer, in that order, as one
 * sequence — because the property that matters is not that each step works but that the
 * later ones cannot disturb the earlier ones. v1 is downloaded, byte for byte, *after* v2
 * exists.
 *
 * The Zone Leader's phone is the public signed-token surface: `GET`, `upload-intent`, PUT
 * straight to storage, `submissions`. No session at any point, exactly as a person holding
 * a link from a PDF has none.
 */

let world: TestWorld;
const base = API_BASE_PATH;

const CONSULTANT_DEVICE = '01930000-0000-7000-8000-00000007e003';

let superAdmin: string;
let consultantToken: string;
let renderer: ReportRenderer;
let worker: ReportWorker;

beforeAll(async () => {
  world = await startWorld();
  superAdmin = world.actors.SUPER_ADMIN.accessToken;
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, CONSULTANT_DEVICE);
  // The render is a separate process in the deployment (STACK.md §4); here the worker is
  // driven directly, which is the same code path minus pg-boss's delivery.
  renderer = world.app.get(ReportRenderer);
  worker = world.app.get(ReportWorker);
}, 180_000);

afterAll(async () => {
  await renderer?.onModuleDestroy();
  await stopWorld(world);
});

describe('Phase 7 acceptance', () => {
  it(
    'generates v1, answers a finding through the link, verifies, and regenerates as v2 ' +
      'while v1 stays downloadable and byte-identical',
    async () => {
      // ---------------------------------------------------------------- the audit
      const walkBy = await completedWalkBy(world, {
        token: consultantToken,
        deviceId: CONSULTANT_DEVICE,
        unitId: world.unitA,
        zoneLeaderUserId: world.actors.ZONE_LEADER.userId,
        nonconformities: 2,
        good: 2,
      });
      expect(walkBy.actions.length).toBe(2);

      // ------------------------------------- 1. Super Admin generates the Initial report
      const queued = await world.request('POST', `${base}/reports/generate`, {
        token: superAdmin,
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        body: { kind: 'INITIAL_ZONE', auditZoneId: walkBy.auditZoneId },
      });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      const v1 = queued.body as ReportSnapshot;
      expect(v1.version).toBe(1);
      expect(v1.status).toBe('QUEUED');

      await worker.handle({ snapshotId: v1.id, requestedByUserId: world.actors.SUPER_ADMIN.userId });

      const v1Ready = (
        await world.request('GET', `${base}/reports/${v1.id}`, { token: superAdmin })
      ).body as ReportSnapshot;
      expect(v1Ready.status).toBe('READY');
      expect(v1Ready.pdfObjectKey).toBe(`report/${world.unitA}/${v1.id}/v1.pdf`);
      expect(v1Ready.pdfChecksumSha256).toMatch(/^[0-9a-f]{64}$/);

      // "…matching the required layout." The PDF's own bytes are opaque, so the assertion
      // is made against the HTML the renderer prints from — the same function, the same
      // frozen payload.
      const v1Payload = (
        await world.request('GET', `${base}/reports/${v1.id}/payload`, { token: superAdmin })
      ).body as ReportPayload;
      const v1Html = renderReportHtml(v1Payload, () => 'data:image/jpeg;base64,AA==');

      expect(v1Html).toContain('LEAN 5S — ZONE REPORT');
      expect(v1Html).toContain('class="good-grid"');
      // The initial report's right half: empty, and textless (§10.3-A).
      expect(v1Html).toContain('<div class="nc-placeholder"></div>');
      // `class="nc-answer"` rather than `nc-answer`: the stylesheet is in the same
      // document and declares the rule, so the bare string would always be present.
      expect(v1Html).not.toContain('class="nc-answer"');
      expect(v1Html).toContain('View / Submit Corrective Action');

      const v1GoodBlock = goodBlockOf(v1Html);
      const v1Bytes = await downloadBytes(v1.id);
      expect(v1Bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

      // ---------------------------- 2. A Zone Leader opens the link on a phone and submits
      const link = v1Payload.zones[0]!.nonconformities[0]!;
      const token = link.correctiveActionUrl!.split('/ca/')[1]!;

      // No session, from here to the end of the submission.
      const page = await world.request('GET', `${base}/public/corrective-actions/${token}`, {
        token: null,
      });
      expect(page.status).toBe(200);
      const item = page.body as PublicCorrectiveAction;
      expect(item.correctiveActionId).toBe(link.correctiveActionId);
      expect(item.submittable).toBe(true);
      expect(item.beforePhotoUrl).toContain('http');

      const submissionId = randomUUID();
      const evidenceId = randomUUID();

      const intent = await world.request(
        'POST',
        `${base}/public/corrective-actions/${token}/upload-intent`,
        {
          token: null,
          headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
          body: {
            id: evidenceId,
            kind: 'CORRECTIVE_AFTER',
            auditId: randomUUID(),
            correctiveActionSubmissionId: submissionId,
            contentType: 'image/jpeg',
            byteSize: TINY_JPEG.byteLength,
            checksumSha256: sha256Hex(TINY_JPEG),
            capturedAt: new Date().toISOString(),
            // The capture component sets this and nothing else does (§12.10).
            isLiveCapture: true,
          },
        },
      );
      expect(intent.status, JSON.stringify(intent.body)).toBe(201);

      const put = await world.app.inject({
        method: 'PUT',
        url: (intent.body as UploadIntentResponse).uploadUrl.replace(/^https?:\/\/[^/]+/, ''),
        headers: { 'content-type': 'image/jpeg' },
        payload: TINY_JPEG,
      });
      expect(put.statusCode, put.body).toBe(200);

      const submitted = await world.request(
        'POST',
        `${base}/public/corrective-actions/${token}/submissions`,
        {
          token: null,
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

      // --------------------------------- 3. …which closed it, with nobody verifying
      //
      // R-23(a): the after-photo is the closure. There is no review step for an Option A
      // answer any more, so the Super Admin's verify is refused rather than redundant —
      // and the finding is already VERIFIED by the time they could ask.
      const afterSubmit = (await world.request(
        'GET',
        `${base}/corrective-actions/${link.correctiveActionId}`,
        { token: superAdmin },
      )).body as CorrectiveActionDetail;
      expect(afterSubmit.status).toBe('VERIFIED');
      // Closed by the submission, so no person verified it — that is the field's whole
      // purpose, and a report that claimed otherwise would be wrong about who signed off.
      expect(afterSubmit.verifiedByUserId).toBeNull();

      const verified = await world.request(
        'POST',
        `${base}/corrective-actions/${link.correctiveActionId}/verify`,
        { token: superAdmin, body: { comment: 'Confirmed on the floor.' } },
      );
      expect(verified.status, JSON.stringify(verified.body)).toBe(409);

      // ------------------------------- 4. …and regenerates as an After-Evidence v2
      //
      // Through `generate` with the after-evidence kind, not `regenerate`: §10.5's chain
      // is v1 INITIAL_ZONE → v2 AFTER_EVIDENCE_ZONE for **one Zone**, so the version
      // sequence belongs to the Zone and this is genuinely its second version.
      // `regenerate` means "issue this same document again", which is a different act.
      const regenerated = await world.request('POST', `${base}/reports/generate`, {
        token: superAdmin,
        headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
        body: { kind: 'AFTER_EVIDENCE_ZONE', auditZoneId: walkBy.auditZoneId },
      });
      expect(regenerated.status, JSON.stringify(regenerated.body)).toBe(202);
      const v2 = regenerated.body as ReportSnapshot;
      expect(v2.version).toBe(2);
      expect(v2.kind).toBe('AFTER_EVIDENCE_ZONE');
      expect(v2.supersedesSnapshotId).toBe(v1.id);

      await worker.handle({ snapshotId: v2.id, requestedByUserId: world.actors.SUPER_ADMIN.userId });

      const v2Ready = (
        await world.request('GET', `${base}/reports/${v2.id}`, { token: superAdmin })
      ).body as ReportSnapshot;
      expect(v2Ready.status).toBe('READY');

      const v2Payload = (
        await world.request('GET', `${base}/reports/${v2.id}/payload`, { token: superAdmin })
      ).body as ReportPayload;
      const v2Html = renderReportHtml(v2Payload, () => 'data:image/jpeg;base64,AA==');

      // The answered finding fills its right half; the other is still Pending.
      expect(v2Html).toContain('class="nc-answer"');
      expect(v2Html).toContain('AFTER PHOTO');
      expect(v2Html).toContain('Submitted by R. Deshmukh');
      expect(v2Html).toContain('✓ VERIFIED');
      expect(v2Html).toContain('PENDING');
      expect(v2Html).toContain('Closure summary');

      // **GOOD photos unchanged between v1 and v2** — the good work is part of the record.
      expect(goodBlockOf(v2Html)).toBe(v1GoodBlock);

      // --------------------------- 5. v1 is still downloadable, and still the same document
      const history = (
        await world.request('GET', `${base}/reports?auditZoneId=${walkBy.auditZoneId}`, {
          token: superAdmin,
        })
      ).body as Page<ReportSnapshot>;
      expect(history.data.map((row) => row.version).sort()).toEqual([1, 2]);

      const v1Again = (
        await world.request('GET', `${base}/reports/${v1.id}`, { token: superAdmin })
      ).body as ReportSnapshot;
      // Not "still READY" — *unchanged*: the same object, the same checksum, the same
      // page count, the same generation time (RS-1).
      expect(v1Again).toEqual(v1Ready);

      const v1BytesAgain = await downloadBytes(v1.id);
      expect(Buffer.compare(v1BytesAgain, v1Bytes)).toBe(0);
      expect(sha256Hex(v1BytesAgain)).toBe(v1Ready.pdfChecksumSha256);

      // And the two versions really are different documents, so the comparison above is
      // not comparing a report with itself.
      const v2Bytes = await downloadBytes(v2.id);
      expect(Buffer.compare(v2Bytes, v1Bytes)).not.toBe(0);
    },
    600_000,
  );
});

/** Follows the presigned GET the download route mints, and returns the bytes. */
async function downloadBytes(snapshotId: string): Promise<Buffer> {
  const link = (
    await world.request('GET', `${base}/reports/${snapshotId}/download-url`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    })
  ).body as ReportDownloadUrl;

  const response = await world.app.inject({
    method: 'GET',
    url: link.url.replace(/^https?:\/\/[^/]+/, ''),
  });
  expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
  return Buffer.from(response.rawPayload);
}

/** The GOOD evidence block, from its heading to the next section. */
function goodBlockOf(html: string): string {
  const start = html.indexOf('>Good evidence</h2>');
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('class="section-title"', start + 1);
  return html.slice(start, next === -1 ? html.length : next);
}
