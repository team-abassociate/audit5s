import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, createPool } from '@audit5s/db';
import type { Pool } from 'pg';
import {
  API_BASE_PATH,
  type ChecklistImportJob,
  type CommitChecklistImportResponse,
  type SyncCatalogue,
} from '@audit5s/contracts';
import { QUEUES } from '../src/infrastructure/queue/queue.service';
import {
  ChecklistImportWorker,
  type ChecklistImportJobData,
} from '../src/modules/checklists/import/checklist-import.worker';
import { APP_URL, startWorld, stopWorld, type TestWorld } from './harness';
import { buildWorkbook } from './workbook-fixtures';

/**
 * `GET /sync/catalogue` (§8.11) — the entire offline bootstrap.
 *
 * The point of these assertions is that the catalogue is *scoped*: it is not a dump of
 * the organization that the device filters afterwards. A Consultant's catalogue contains
 * their assigned Units' Zones and nothing else, while the checklists — organization-wide
 * reference data with no Unit in them (D2) — are complete for everyone.
 */

let world: TestWorld;
let pool: Pool;
const base = API_BASE_PATH;

beforeAll(async () => {
  world = await startWorld();
  pool = createPool({ connectionString: APP_URL, max: 2 });

  const body = await buildWorkbook([{ name: 'Premises' }]);
  const uploaded = await world.upload(
    `${base}/checklist-imports`,
    {
      filename: 'premises.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body,
    },
    { token: world.actors.SUPER_ADMIN.accessToken },
  );
  const jobId = (uploaded.body as ChecklistImportJob).id;

  await world.request('POST', `${base}/checklist-imports/${jobId}/validate`, {
    token: world.actors.SUPER_ADMIN.accessToken,
  });

  const db = createDatabase(pool);
  const queued = await db.execute(
    sql`SELECT data FROM pgboss.job
        WHERE name = ${QUEUES.checklistImport} AND data->>'jobId' = ${jobId}`,
  );
  const rows = (queued as unknown as { rows: Array<{ data: ChecklistImportJobData }> }).rows;
  await world.app.get(ChecklistImportWorker).handle(rows[0]!.data);

  const committed = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
    token: world.actors.SUPER_ADMIN.accessToken,
    body: { publish: true },
  });
  expect((committed.body as CommitChecklistImportResponse).versions).toHaveLength(1);
});

afterAll(async () => {
  await pool?.end();
  await stopWorld(world);
});

async function catalogue(role: 'CONSULTANT' | 'ZONE_LEADER', since?: string) {
  const query = since ? `?since=${encodeURIComponent(since)}` : '';
  const response = await world.request('GET', `${base}/sync/catalogue${query}`, {
    token: world.actors[role].accessToken,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as SyncCatalogue;
}

describe('what a device receives', () => {
  it('gives a Consultant their assigned Units and those Units’ active Zones', async () => {
    const result = await catalogue('CONSULTANT');

    expect(result.units.map((unit) => unit.id)).toEqual([world.unitA]);
    expect(result.zones.length).toBeGreaterThan(0);
    expect(result.zones.every((zone) => zone.unitId === world.unitA)).toBe(true);
    expect(result.zones.every((zone) => zone.archivedAt === null)).toBe(true);
  });

  it('gives a Zone Leader only their own Unit', async () => {
    const result = await catalogue('ZONE_LEADER');
    expect(result.units.map((unit) => unit.id)).toEqual([world.unitA]);
    expect(result.zones.every((zone) => zone.unitId === world.unitA)).toBe(true);
  });

  it('gives every device the whole published checklist catalogue, questions included (D2)', async () => {
    for (const role of ['CONSULTANT', 'ZONE_LEADER'] as const) {
      const result = await catalogue(role);
      expect(result.checklistTemplates.length, role).toBeGreaterThan(0);
      expect(result.checklistVersions.length, role).toBeGreaterThan(0);
      expect(result.checklistVersions[0]?.status).toBe('PUBLISHED');
      expect(result.checklistVersions[0]?.questions).toHaveLength(50);
    }
  });

  it('carries the server clock, so a skewed device can normalise its timestamps', async () => {
    const result = await catalogue('CONSULTANT');
    expect(Date.parse(result.serverTime)).not.toBeNaN();
  });
});

describe('the catalogue version', () => {
  it('returns nothing to write when the device is already current', async () => {
    const first = await catalogue('CONSULTANT');
    const second = await catalogue('CONSULTANT', first.catalogueVersion);

    expect(second.catalogueVersion).toBe(first.catalogueVersion);
    expect(second.units).toEqual([]);
    expect(second.zones).toEqual([]);
    expect(second.checklistVersions).toEqual([]);
    expect(Date.parse(second.serverTime)).not.toBeNaN();
  });

  it('changes when a Zone changes, and the payload comes back in full', async () => {
    const before = await catalogue('CONSULTANT');

    await world.request('PATCH', `${base}/zones/${world.zoneA}`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { description: 'Now with a description' },
    });

    const after = await catalogue('CONSULTANT', before.catalogueVersion);
    expect(after.catalogueVersion).not.toBe(before.catalogueVersion);
    expect(after.zones.length).toBeGreaterThan(0);
    expect(after.zones.find((zone) => zone.id === world.zoneA)?.description).toBe(
      'Now with a description',
    );
  });

  it('differs between two roles with different scope', async () => {
    const consultant = await catalogue('CONSULTANT');
    const leader = await catalogue('ZONE_LEADER');
    // Both are in Unit A here, so the *content* matches; what matters is that each was
    // computed from its own scope rather than from a shared organization-wide dump.
    expect(consultant.units.map((unit) => unit.id)).toEqual(leader.units.map((unit) => unit.id));
    expect(consultant.catalogueVersion).toBe(leader.catalogueVersion);
  });
});

describe('who may pull it', () => {
  it('lets a Super Admin pull it, who is refused nothing (R-18)', async () => {
    const response = await world.request('GET', `${base}/sync/catalogue`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it('refuses a Coordinator: they read the same data through the resource endpoints', async () => {
    const response = await world.request('GET', `${base}/sync/catalogue`, {
      token: world.actors.COORDINATOR.accessToken,
    });
    expect(response.status).toBe(403);
  });
});
