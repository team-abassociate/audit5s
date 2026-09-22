import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  HEADER_IDEMPOTENCY_KEY,
  type AuditScoreSummary,
  type Page,
  type ReportAccessToken,
  type ReportPayload,
  type ReportSnapshot,
} from '@audit5s/contracts';
import { FIXTURE_PASSWORD, loginFromDevice, startWorld, stopWorld, type TestWorld } from './harness';
import { completedWalkBy, makeZone } from './corrective-fixtures';

/**
 * Reports (§8.9, PART 10), through the real endpoints.
 *
 * The properties this suite exists to pin are the ones PART 14's Phase 7 row names and the
 * ones that are expensive to discover late:
 *
 *   * **Regeneration creates v2 and leaves v1 byte-identical** (RS-1). Not "usually" — the
 *     database refuses the alternative, and that refusal is asserted directly.
 *   * **A summary over a Zone subset uses only those Zones.** A Unit-wide figure filtered
 *     after the fact is a different number, and §10.3 says so explicitly.
 *   * **A Consultant gets 403 on `/reports/generate`** (N5) — from the absent permission,
 *     not from a scope.
 *
 * The render itself is not exercised here: `worker-report` is a separate process and the
 * API returns 202. `report-render.e2e.test.ts` covers the renderer against a fixed payload.
 */

let world: TestWorld;
const base = API_BASE_PATH;

const CONSULTANT_DEVICE = '01930000-0000-7000-8000-00000007e001';

let superAdmin: string;
let consultantToken: string;
let coordinator: string;
let leader: string;

beforeAll(async () => {
  world = await startWorld();
  superAdmin = world.actors.SUPER_ADMIN.accessToken;
  coordinator = world.actors.COORDINATOR.accessToken;
  leader = world.actors.ZONE_LEADER.accessToken;
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, CONSULTANT_DEVICE);
}, 180_000);

afterAll(async () => {
  await stopWorld(world);
});

/** A completed walk-by Zone with two findings and one good photo — a report's raw material. */
async function completedZone(options: { nonconformities?: number; good?: number } = {}) {
  return completedWalkBy(world, {
    token: consultantToken,
    deviceId: CONSULTANT_DEVICE,
    unitId: world.unitA,
    zoneLeaderUserId: world.actors.ZONE_LEADER.userId,
    nonconformities: options.nonconformities ?? 2,
    good: options.good ?? 1,
  });
}

function generate(token: string, body: unknown, key = randomUUID()) {
  return world.request('POST', `${base}/reports/generate`, {
    token,
    headers: { [HEADER_IDEMPOTENCY_KEY]: key },
    body,
  });
}

describe('POST /reports/generate', () => {
  it('freezes a payload, returns 202 QUEUED, and mints a link per open finding', async () => {
    const { auditZoneId } = await completedZone();

    const response = await generate(superAdmin, { kind: 'INITIAL_ZONE', auditZoneId });
    expect(response.status, JSON.stringify(response.body)).toBe(202);

    const snapshot = response.body as ReportSnapshot;
    expect(snapshot.status).toBe('QUEUED');
    expect(snapshot.version).toBe(1);
    expect(snapshot.kind).toBe('INITIAL_ZONE');
    expect(snapshot.supersedesSnapshotId).toBeNull();
    // Never a PDF on the request path (STACK.md §5): the object arrives with the render.
    expect(snapshot.pdfObjectKey).toBeNull();

    const tokens = await world.request('GET', `${base}/reports/${snapshot.id}/tokens`, {
      token: superAdmin,
    });
    expect(tokens.status).toBe(200);
    // One per nonconformity, none verified yet.
    expect((tokens.body as ReportAccessToken[]).length).toBe(2);
    for (const minted of tokens.body as ReportAccessToken[]) {
      expect(minted.purpose).toBe('CORRECTIVE_ACTION');
      expect(minted.active).toBe(true);
      expect(minted.correctiveActionId).not.toBeNull();
      // The secret is not in the response and cannot be: only its hash is stored.
      expect(JSON.stringify(minted)).not.toContain('tokenHash');
    }
  }, 120_000);

  it('freezes the link into the payload, so the PDF can print a button (R-14)', async () => {
    const { auditZoneId } = await completedZone();
    const snapshot = (await generate(superAdmin, { kind: 'INITIAL_ZONE', auditZoneId }))
      .body as ReportSnapshot;

    const payload = (
      await world.request('GET', `${base}/reports/${snapshot.id}/payload`, { token: superAdmin })
    ).body as ReportPayload;

    const zone = payload.zones[0]!;
    expect(zone.nonconformities.length).toBe(2);
    for (const item of zone.nonconformities) {
      expect(item.correctiveActionUrl).toMatch(/\/ca\/[A-Za-z0-9_-]{40,}$/);
    }
    // And the palette travels with the report, so December's reopen looks like March's.
    expect(payload.bands.length).toBe(4);
    expect(payload.bands[0]!.label).toBe('Outstanding');
    expect(payload.brand.ink).toBe('#601A16');
  }, 120_000);

  it('refuses an audit that is not completed', async () => {
    const auditId = randomUUID();
    await world.request('POST', `${base}/audits`, {
      token: consultantToken,
      headers: { 'x-device-id': CONSULTANT_DEVICE },
      body: {
        id: auditId,
        auditType: 'WALK_BY',
        unitId: world.unitA,
        deviceId: CONSULTANT_DEVICE,
      },
    });
    const zoneId = await makeZone(world, world.unitA, null);
    const auditZoneId = randomUUID();
    await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
      token: consultantToken,
      headers: { 'x-device-id': CONSULTANT_DEVICE },
      body: { zoneId, sequenceNo: 1, clientUpdatedAt: new Date().toISOString() },
    });

    const response = await generate(superAdmin, { kind: 'INITIAL_ZONE', auditZoneId });
    expect(response.status).toBe(409);
    expect((response.body as { detail: string }).detail).toMatch(/not completed/i);
  }, 120_000);

  /** N5/C4, and the reason it is a 403: the role holds no cell at all, so scope never runs. */
  it('refuses a Consultant with 403 from the absent permission, not 404 from a scope', async () => {
    const { auditZoneId } = await completedZone();
    const response = await generate(consultantToken, { kind: 'INITIAL_ZONE', auditZoneId });

    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe('FORBIDDEN');
  }, 120_000);

  it('gives a Consultant the score summary instead — a read model, not a report (N6)', async () => {
    const { auditId } = await completedZone();
    const response = await world.request('GET', `${base}/audits/${auditId}/summary`, {
      token: consultantToken,
    });

    expect(response.status).toBe(200);
    const summary = response.body as AuditScoreSummary;
    // A walk-by is not scored (§2.7): the summary says so rather than reporting zero.
    expect(summary.scored).toBe(false);
    expect(summary.audit.totals.scorePercentage).toBeNull();
  }, 120_000);
});

describe('versioning and regeneration (RS-1)', () => {
  it('creates v2, chains it to v1, and leaves v1 exactly as it was issued', async () => {
    const { auditZoneId } = await completedZone();
    const v1 = (await generate(superAdmin, { kind: 'INITIAL_ZONE', auditZoneId }))
      .body as ReportSnapshot;

    // Pretend the worker finished v1, so there is something to be immutable about.
    await world.owner.query(
      `UPDATE report_snapshot
          SET status = 'READY', pdf_object_key = $2, pdf_checksum_sha256 = $3, page_count = 4
        WHERE id = $1`,
      [v1.id, `report/${world.unitA}/${v1.id}/v1.pdf`, 'a'.repeat(64)],
    );

    const before = await snapshotRow(v1.id);

    const v2 = (
      await world.request('POST', `${base}/reports/${v1.id}/regenerate`, { token: superAdmin })
    ).body as ReportSnapshot;

    expect(v2.version).toBe(2);
    expect(v2.supersedesSnapshotId).toBe(v1.id);
    expect(v2.id).not.toBe(v1.id);
    // "Version 1 is untouched and remains downloadable" (§10.3-B).
    expect(await snapshotRow(v1.id)).toEqual(before);

    const history = (
      await world.request('GET', `${base}/reports?auditZoneId=${auditZoneId}`, {
        token: superAdmin,
      })
    ).body as Page<ReportSnapshot>;
    expect(history.data.map((row) => row.version).sort()).toEqual([1, 2]);
  }, 120_000);

  it('refuses at the database to rewrite a READY snapshot, whatever the code does', async () => {
    const { auditZoneId } = await completedZone();
    const snapshot = (await generate(superAdmin, { kind: 'INITIAL_ZONE', auditZoneId }))
      .body as ReportSnapshot;

    await world.owner.query(
      `UPDATE report_snapshot SET status = 'READY', pdf_object_key = $2,
              pdf_checksum_sha256 = $3 WHERE id = $1`,
      [snapshot.id, 'report/x/y/v1.pdf', 'b'.repeat(64)],
    );

    // RS-1 is a trigger, not a convention the worker happens to follow.
    await expect(
      world.owner.query(`UPDATE report_snapshot SET payload = '{}'::jsonb WHERE id = $1`, [
        snapshot.id,
      ]),
    ).rejects.toThrow(/READY and immutable|RS-1/);

    await expect(
      world.owner.query(`DELETE FROM report_snapshot WHERE id = $1`, [snapshot.id]),
    ).rejects.toThrow();
  }, 120_000);

  it('refuses to rewrite a queued snapshot’s payload, at any status', async () => {
    const { auditZoneId } = await completedZone();
    const snapshot = (await generate(superAdmin, { kind: 'INITIAL_ZONE', auditZoneId }))
      .body as ReportSnapshot;

    await expect(
      world.owner.query(`UPDATE report_snapshot SET version = 99 WHERE id = $1`, [snapshot.id]),
    ).rejects.toThrow(/never change|RS-1/);

    // The worker's own write-back is still permitted: QUEUED → RENDERING → READY.
    await world.owner.query(`UPDATE report_snapshot SET status = 'RENDERING' WHERE id = $1`, [
      snapshot.id,
    ]);
  }, 120_000);
});

describe('MULTI_ZONE_SUMMARY aggregates over the selection only (§10.3-C)', () => {
  it('includes exactly the Zones asked for, not every Zone of the Unit', async () => {
    const first = await completedZone({ nonconformities: 1, good: 1 });
    const second = await completedZone({ nonconformities: 1, good: 1 });
    const excluded = await completedZone({ nonconformities: 1, good: 1 });

    const response = await generate(superAdmin, {
      kind: 'MULTI_ZONE_SUMMARY',
      unitId: world.unitA,
      selectedZoneIds: [first.zoneId, second.zoneId],
    });
    expect(response.status).toBe(202);
    const snapshot = response.body as ReportSnapshot;
    expect(snapshot.selectedZoneIds).toEqual([first.zoneId, second.zoneId]);

    const payload = (
      await world.request('GET', `${base}/reports/${snapshot.id}/payload`, { token: superAdmin })
    ).body as ReportPayload;

    expect(payload.zones.length).toBe(2);
    const includedIds = payload.zones.map((zone) => zone.auditZoneId);
    expect(includedIds).toContain(first.auditZoneId);
    expect(includedIds).toContain(second.auditZoneId);
    // The whole point: a Unit-wide figure filtered afterwards is not this number.
    expect(includedIds).not.toContain(excluded.auditZoneId);
    expect(payload.audit).toBeNull();
  }, 180_000);

  it('refuses a selection with no completed audit rather than issuing an empty report', async () => {
    const emptyZone = await makeZone(world, world.unitA, null);
    const response = await generate(superAdmin, {
      kind: 'MULTI_ZONE_SUMMARY',
      unitId: world.unitA,
      selectedZoneIds: [emptyZone],
    });

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/No completed audit/i);
  }, 120_000);
});

/**
 * Two Consultants, one Unit, one day — the product owner's case: "the zones audited by
 * consultant A and consultant B should be displayed together... it should be one audit".
 *
 * The Summary Report is already the answer, and this pins it. `MULTI_ZONE_SUMMARY` is
 * scoped to a **Unit and a Zone selection**, never to an audit: `resolveLatestAuditZones`
 * takes the latest completed `audit_zone` per Zone in the Unit without looking at which
 * audit or which auditor it belongs to. So the two Consultants' work arrives in one
 * document, under one Unit heading, with one set of totals.
 *
 * R-29 keeps them off each other's Zones while they work; this is the other half — what
 * happens when the work is read back.
 */
describe('a Unit audited by two Consultants reads back as one summary', () => {
  /** A second Consultant, with their own phone, in the same Unit. */
  async function secondConsultant(): Promise<{ token: string; userId: string; name: string }> {
    const argon2 = await import('argon2');
    const { ARGON2_OPTIONS } = await import('../src/modules/auth/password.service');
    const name = 'Bhavna Consult';
    const loginId = 'BH7007';
    const { rows } = await world.owner.query(
      `INSERT INTO "user" (login_id, full_name, phone_e164, role, password_hash,
                           must_reset_password, status)
       VALUES ($1, $2, '+919000007007', 'CONSULTANT', $3, false, 'ACTIVE') RETURNING id`,
      [loginId, name, await argon2.hash(FIXTURE_PASSWORD, ARGON2_OPTIONS)],
    );
    const userId = rows[0].id as string;
    await world.owner.query(
      `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
       VALUES ($1, $2, 'CONSULTANT', $1)`,
      [userId, world.unitA],
    );
    const token = await loginFromDevice(
      world,
      { role: 'CONSULTANT', userId, loginId, accessToken: '', refreshToken: '', unitId: world.unitA },
      '01930000-0000-7000-8000-00000007e002',
    );
    return { token, userId, name };
  }

  it('puts both auditors’ Zones in one document, under both their names', async () => {
    const other = await secondConsultant();

    // Consultant A takes one Zone; Consultant B takes another, in the same Unit.
    const byA = await completedZone({ nonconformities: 1, good: 1 });
    const byB = await completedWalkBy(world, {
      token: other.token,
      deviceId: '01930000-0000-7000-8000-00000007e002',
      unitId: world.unitA,
      zoneLeaderUserId: world.actors.ZONE_LEADER.userId,
      nonconformities: 1,
      good: 1,
    });

    // Two separate audits on the record — which is what they are.
    expect(byA.auditId).not.toBe(byB.auditId);

    const response = await generate(superAdmin, {
      kind: 'MULTI_ZONE_SUMMARY',
      unitId: world.unitA,
      selectedZoneIds: [byA.zoneId, byB.zoneId],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const snapshot = response.body as ReportSnapshot;

    const payload = (
      await world.request('GET', `${base}/reports/${snapshot.id}/payload`, { token: superAdmin })
    ).body as ReportPayload;

    // One document, both Zones.
    expect(payload.zones.map((zone) => zone.auditZoneId).sort()).toEqual(
      [byA.auditZoneId, byB.auditZoneId].sort(),
    );
    expect(new Set(payload.zones.map((zone) => zone.auditId)).size).toBe(2);

    // Both Consultants named — this is the "two different IDs of the respective
    // consultants" the product owner asked for, and the Summary Report prints it as
    // "Auditor name: A, B".
    expect(payload.auditorNames).toContain('Cara Consult');
    expect(payload.auditorNames).toContain(other.name);

    // No single-audit block: the document does not pick one of them and drop the other.
    expect(payload.audit).toBeNull();

    // One Unit heading and one set of totals over the whole selection.
    expect(payload.unit.id).toBe(world.unitA);
    expect(payload.totals).toBeDefined();
  }, 240_000);
});

describe('reading and downloading', () => {
  it('lets a Coordinator and a Zone Leader read their own Unit’s report', async () => {
    const { auditZoneId } = await completedZone();
    const snapshot = (await generate(superAdmin, { kind: 'INITIAL_ZONE', auditZoneId }))
      .body as ReportSnapshot;

    for (const token of [coordinator, leader]) {
      const response = await world.request('GET', `${base}/reports/${snapshot.id}`, { token });
      expect(response.status).toBe(200);
    }
  }, 120_000);

  it('hides another Unit’s report behind a 404, never a 403 (AZ-3)', async () => {
    const { auditZoneId } = await completedZone();
    const snapshot = (await generate(superAdmin, { kind: 'INITIAL_ZONE', auditZoneId }))
      .body as ReportSnapshot;

    // Move it to Unit B; the Coordinator of Unit A must not learn that it exists.
    await world.owner.query(`UPDATE report_snapshot SET unit_id = $2 WHERE id = $1`, [
      snapshot.id,
      world.unitB,
    ]);

    const response = await world.request('GET', `${base}/reports/${snapshot.id}`, {
      token: coordinator,
    });
    expect(response.status).toBe(404);
  }, 120_000);

  it('refuses a download while the report is still rendering, and says why', async () => {
    const { auditZoneId } = await completedZone();
    const snapshot = (await generate(superAdmin, { kind: 'INITIAL_ZONE', auditZoneId }))
      .body as ReportSnapshot;

    const response = await world.request('GET', `${base}/reports/${snapshot.id}/download-url`, {
      token: superAdmin,
    });
    expect(response.status).toBe(409);
    expect((response.body as { detail: string }).detail).toMatch(/still rendering/i);
  }, 120_000);

  it('mints a short-TTL presigned GET once the report is READY (§12.6)', async () => {
    const { auditZoneId } = await completedZone();
    const snapshot = (await generate(superAdmin, { kind: 'INITIAL_ZONE', auditZoneId }))
      .body as ReportSnapshot;

    await world.owner.query(
      `UPDATE report_snapshot SET status = 'READY', pdf_object_key = $2,
              pdf_checksum_sha256 = $3 WHERE id = $1`,
      [snapshot.id, `report/${world.unitA}/${snapshot.id}/v1.pdf`, 'c'.repeat(64)],
    );

    const response = await world.request('GET', `${base}/reports/${snapshot.id}/download-url`, {
      token: superAdmin,
    });
    expect(response.status).toBe(200);
    const download = response.body as { url: string; expiresIn: number; checksumSha256: string };
    expect(download.url).toContain('http');
    expect(download.expiresIn).toBeLessThanOrEqual(300);
    expect(download.checksumSha256).toBe('c'.repeat(64));
  }, 120_000);
});

describe('POST /reports/preview', () => {
  it('returns HTML without writing a snapshot or minting a link', async () => {
    const { auditZoneId } = await completedZone();
    const before = await countSnapshots();
    const beforeTokens = await countTokens();

    const response = await world.request('POST', `${base}/reports/preview`, {
      token: superAdmin,
      headers: { [HEADER_IDEMPOTENCY_KEY]: randomUUID() },
      body: { kind: 'INITIAL_ZONE', auditZoneId },
    });

    expect(response.status).toBe(200);
    expect(String(response.body)).toContain('LEAN 5S — ZONE REPORT');
    expect(await countSnapshots()).toBe(before);
    // A preview that issued live links would be a way to issue links without a report.
    expect(await countTokens()).toBe(beforeTokens);
  }, 120_000);
});

async function snapshotRow(id: string) {
  const { rows } = await world.owner.query(
    `SELECT payload, version, kind, pdf_object_key, pdf_checksum_sha256, page_count, generated_at
       FROM report_snapshot WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function countSnapshots(): Promise<number> {
  const { rows } = await world.owner.query(`SELECT count(*)::int AS n FROM report_snapshot`);
  return rows[0].n as number;
}

async function countTokens(): Promise<number> {
  const { rows } = await world.owner.query(`SELECT count(*)::int AS n FROM report_access_token`);
  return rows[0].n as number;
}
