import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, createPool } from '@audit5s/db';
import type { Pool } from 'pg';
import {
  API_BASE_PATH,
  type ChecklistImportJob,
  type ChecklistImportPreview,
  type ChecklistVersion,
  type CommitChecklistImportResponse,
  type Page,
  type SyncCatalogue,
  type Zone,
} from '@audit5s/contracts';
import { zoneCodeForNumber } from '@audit5s/domain';
import { QUEUES } from '../src/infrastructure/queue/queue.service';
import {
  ChecklistImportWorker,
  type ChecklistImportJobData,
} from '../src/modules/checklists/import/checklist-import.worker';
import { APP_URL, startWorld, stopWorld, type TestWorld } from './harness';
import { buildWorkbook } from './workbook-fixtures';

/**
 * The Phase 2 acceptance row (ARCHITECTURE.md PART 14), walked literally as one narrative:
 *
 *   "Super Admin imports the department workbook, sees a validation report with row-level
 *    errors, previews the diff, commits and publishes; the version becomes visible to a
 *    mobile device after catalogue sync; a Coordinator creates 20 Zones and 5 Zone Leaders
 *    in their own Unit and cannot touch another Unit's."
 *
 * The individual rules have focused tests of their own. This exists because the criterion
 * is a *sequence*: the workbook that fails validation is the same one, corrected, that
 * gets committed; the version the Super Admin publishes is the one the device then pulls;
 * and the Coordinator's twenty Zones have to be twenty in *their* Unit specifically.
 *
 * The device half stops at `GET /sync/catalogue`, which is the server boundary. What
 * happens to that payload on the device — the wholesale replace into SQLite, the questions
 * read back under their section headings — is asserted against real SQLite in
 * `apps/field-mobile/src/lib/db/catalogue.repository.test.ts`.
 */
describe('Phase 2 acceptance', () => {
  let world: TestWorld;
  let pool: Pool;
  const url = (path: string) => `${API_BASE_PATH}${path}`;
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  beforeAll(async () => {
    world = await startWorld();
    pool = createPool({ connectionString: APP_URL, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
    await stopWorld(world);
  });

  /** Uploads, then lets worker-general run the parse, exactly as production would. */
  async function uploadAndValidate(body: Buffer, filename: string): Promise<string> {
    const admin = world.actors.SUPER_ADMIN.accessToken;

    const uploaded = await world.upload(
      url('/checklist-imports'),
      { filename, contentType: XLSX, body },
      { token: admin },
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const jobId = (uploaded.body as ChecklistImportJob).id;

    const accepted = await world.request('POST', url(`/checklist-imports/${jobId}/validate`), {
      token: admin,
    });
    expect(accepted.status).toBe(202);

    const queued = await createDatabase(pool).execute(
      sql`SELECT data FROM pgboss.job
          WHERE name = ${QUEUES.checklistImport} AND data->>'jobId' = ${jobId}`,
    );
    const rows = (queued as unknown as { rows: Array<{ data: ChecklistImportJobData }> }).rows;
    expect(rows, 'the parse must go through pg-boss').toHaveLength(1);

    await world.app.get(ChecklistImportWorker).handle(rows[0]!.data);
    return jobId;
  }

  it('runs end to end', async () => {
    const admin = world.actors.SUPER_ADMIN.accessToken;
    const coordinator = world.actors.COORDINATOR.accessToken;

    // --- 1. A workbook with a broken sheet, and the row-level report it earns ---
    // Two departments: one correct, one whose 3S block lost a row and whose Sr. sequence
    // therefore no longer runs 1…50.
    const broken = await buildWorkbook([
      { name: 'Premises' },
      { name: 'Office', counts: [10, 10, 9, 10, 10] },
    ]);
    const brokenJobId = await uploadAndValidate(broken, 'workbook-draft.xlsx');

    const brokenPreview = await world.request(
      'GET',
      url(`/checklist-imports/${brokenJobId}/preview`),
      { token: admin },
    );
    expect(brokenPreview.status).toBe(200);
    const report = brokenPreview.body as ChecklistImportPreview;

    const office = report.sheets.find((sheet) => sheet.sheetName === 'Office')!;
    expect(office.severity).toBe('ERROR');
    expect(office.messages).toContain(
      'Section S3_SHINE has 9 questions; exactly 10 are required',
    );

    // Row-level, not merely a verdict on the file: each error names the sheet row it came
    // from, which is what makes the report usable in front of the spreadsheet.
    expect(report.errors.length).toBeGreaterThan(0);
    for (const error of report.errors) {
      expect(error.sourceRowNumber).toBeGreaterThan(0);
      expect(error.messages.length).toBeGreaterThan(0);
    }

    // …and the annotated workbook is downloadable.
    const annotated = await world.request(
      'GET',
      url(`/checklist-imports/${brokenJobId}/error-report`),
      { token: admin },
    );
    expect(annotated.status).toBe(200);
    expect(Buffer.from(annotated.body as Buffer).subarray(0, 2).toString()).toBe('PK');

    // Committing it is refused, and nothing has been written.
    const refused = await world.request('POST', url(`/checklist-imports/${brokenJobId}/commit`), {
      token: admin,
      body: {},
    });
    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe('IMPORT_VALIDATION_FAILED');

    const nothingYet = await world.request('GET', url('/checklist-versions?limit=200'), {
      token: admin,
    });
    expect((nothingYet.body as Page<ChecklistVersion>).data).toEqual([]);

    // --- 2. The real department workbook, corrected and complete ---------------
    const workbook = await readFile(
      resolve(__dirname, '..', '..', '..', 'docs', 'requirements', '5S_lean_audit_data_1.xlsx'),
    );
    const jobId = await uploadAndValidate(workbook, '5S_lean_audit_data_1.xlsx');

    const previewed = await world.request('GET', url(`/checklist-imports/${jobId}/preview`), {
      token: admin,
    });
    const preview = previewed.body as ChecklistImportPreview;

    expect(preview.job.errorCount).toBe(0);
    expect(preview.sheets).toHaveLength(9);

    // --- 3. …previews the diff -------------------------------------------------
    // No published version yet, so every question is an addition — and the diff says so
    // per sheet rather than as one number over the whole file.
    expect(preview.diffs).toHaveLength(9);
    for (const diff of preview.diffs) {
      expect(diff.currentVersionNumber).toBeNull();
      expect(diff.added).toBe(50);
      expect(diff.entries).toHaveLength(50);
    }

    // --- 4. …commits and publishes ---------------------------------------------
    const committed = await world.request('POST', url(`/checklist-imports/${jobId}/commit`), {
      token: admin,
      body: { publish: true },
    });
    expect(committed.status, JSON.stringify(committed.body)).toBe(201);

    const { versions } = committed.body as CommitChecklistImportResponse;
    expect(versions).toHaveLength(9);
    expect(versions.every((version) => version.status === 'PUBLISHED')).toBe(true);
    expect(versions.map((version) => version.templateCode)).toEqual([
      'SHOP_FLOOR',
      'OFFICE',
      'STORES_RM',
      'PRODUCTION',
      'FG_STORES',
      'PACKING_AREA',
      'BOILER_UTILITY',
      'MAINTENANCE',
      'PREMISES',
    ]);

    // --- 5. The version becomes visible to a mobile device on catalogue sync ----
    const catalogue = await world.request('GET', url('/sync/catalogue'), {
      token: world.actors.CONSULTANT.accessToken,
    });
    expect(catalogue.status).toBe(200);
    const payload = catalogue.body as SyncCatalogue;

    expect(payload.checklistVersions).toHaveLength(9);
    expect(payload.checklistVersions.every((version) => version.status === 'PUBLISHED')).toBe(
      true,
    );
    // The questions travel with it: the questionnaire never needs a network call.
    for (const version of payload.checklistVersions) {
      expect(version.questions, version.templateName).toHaveLength(50);
    }
    // And the Consultant's own Units and Zones came with it, scope-filtered.
    expect(payload.units.map((unit) => unit.id)).toEqual([world.unitA]);
    expect(payload.zones.every((zone) => zone.unitId === world.unitA)).toBe(true);

    // --- 6. A Coordinator creates 20 Zones in their own Unit -------------------
    for (let zoneNumber = 1; zoneNumber <= 20; zoneNumber += 1) {
      // Zone 1's code is taken by the fixture Zone, so the acceptance run starts at 30.
      const code = zoneCodeForNumber(zoneNumber + 29);
      const created = await world.request('POST', url(`/units/${world.unitA}/zones`), {
        token: coordinator,
        body: { code, name: `Acceptance zone ${zoneNumber}`, sortOrder: zoneNumber + 29 },
      });
      expect(created.status, `zone ${code}: ${JSON.stringify(created.body)}`).toBe(201);
    }

    const ownZones = await world.request('GET', url(`/units/${world.unitA}/zones?limit=200`), {
      token: coordinator,
    });
    const zones = (ownZones.body as Page<Zone>).data;
    expect(zones.filter((zone) => zone.name.startsWith('Acceptance zone'))).toHaveLength(20);
    expect(zones.every((zone) => zone.unitId === world.unitA)).toBe(true);

    // --- 7. …and 5 Zone Leaders ------------------------------------------------
    const leaderIds: string[] = [];
    for (let leader = 1; leader <= 5; leader += 1) {
      const created = await world.request('POST', url('/users'), {
        token: coordinator,
        body: {
          fullName: `Acceptance Leader ${leader}`,
          phone: `+9199000000${String(leader).padStart(2, '0')}`,
          role: 'ZONE_LEADER',
        },
      });
      expect(created.status, `leader ${leader}: ${JSON.stringify(created.body)}`).toBe(201);
      leaderIds.push((created.body as { user: { id: string } }).user.id);
    }

    // A Zone Leader is only useful once a Zone points at them.
    const assigned = await world.request('POST', url(`/zones/${zones[0]!.id}/leader`), {
      token: coordinator,
      body: { zoneLeaderId: leaderIds[0] },
    });
    expect(assigned.status).toBe(200);
    expect((assigned.body as Zone).zoneLeaderName).toBe('Acceptance Leader 1');

    // --- 8. …and cannot touch another Unit's ----------------------------------
    const foreignCreate = await world.request('POST', url(`/units/${world.unitB}/zones`), {
      token: coordinator,
      body: { code: 'Z-99', name: 'Trespass' },
    });
    // 404, not 403: the Unit exists, and the response must not say so (AZ-3).
    expect(foreignCreate.status).toBe(404);

    const foreignRead = await world.request('GET', url(`/zones/${world.zoneB}`), {
      token: coordinator,
    });
    expect(foreignRead.status).toBe(404);

    const foreignEdit = await world.request('PATCH', url(`/zones/${world.zoneB}`), {
      token: coordinator,
      body: { description: 'Not mine' },
    });
    expect(foreignEdit.status).toBe(404);

    const foreignArchive = await world.request('POST', url(`/zones/${world.zoneB}/archive`), {
      token: coordinator,
    });
    expect(foreignArchive.status).toBe(404);

    // Their own Unit's list is unaffected by any of it.
    const stillOwn = await world.request('GET', url('/zones?limit=200'), { token: coordinator });
    expect((stillOwn.body as Page<Zone>).data.every((zone) => zone.unitId === world.unitA)).toBe(
      true,
    );

    // --- 9. …and the whole sequence is in the audit log ------------------------
    const log = await world.request('GET', url('/audit-logs?limit=200'), { token: admin });
    const actions = new Set(
      (log.body as Page<{ action: string }>).data.map((entry) => entry.action),
    );
    expect(actions).toContain('checklist.imported');
    expect(actions).toContain('checklist.published');
    expect(actions).toContain('zone.created');
    expect(actions).toContain('zone.leader_assigned');
    expect(actions).toContain('user.created');
  });
});
