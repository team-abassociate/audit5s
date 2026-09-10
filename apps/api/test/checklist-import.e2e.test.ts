import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, createPool } from '@audit5s/db';
import type { Pool } from 'pg';
import {
  API_BASE_PATH,
  type ChecklistImportJob,
  type ChecklistImportPreview,
  type ChecklistVersionDetail,
  type CommitChecklistImportResponse,
} from '@audit5s/contracts';
import { QUEUES } from '../src/infrastructure/queue/queue.service';
import {
  ChecklistImportWorker,
  type ChecklistImportJobData,
} from '../src/modules/checklists/import/checklist-import.worker';
import { APP_URL, startWorld, stopWorld, type TestWorld } from './harness';
import { buildWorkbook, validWorkbook } from './workbook-fixtures';

/**
 * The six-stage Excel import (§8.5), end to end.
 *
 * Every case in Phase 2's Tests row: a valid file, a missing section, 9 and 11 questions
 * in a section, duplicate text, a byte-identical re-import blocked, and the older-version
 * revert warning — plus the two rules that make the whole thing safe: nothing is written
 * before COMMIT, and the parse really is enqueued onto worker-general.
 */

let world: TestWorld;
let pool: Pool;
const base = API_BASE_PATH;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

beforeAll(async () => {
  world = await startWorld();
  pool = createPool({ connectionString: APP_URL, max: 2 });
});

afterAll(async () => {
  await pool?.end();
  await stopWorld(world);
});

const token = () => world.actors.SUPER_ADMIN.accessToken;

async function upload(body: Buffer, filename = 'workbook.xlsx') {
  return world.upload(
    `${base}/checklist-imports`,
    { filename, contentType: XLSX, body },
    { token: token() },
  );
}

/**
 * Validates through the real path: the API enqueues, and the worker's own handler runs
 * the job. The queue row is asserted first, so this cannot silently become an in-process
 * call that skips pg-boss entirely (R-2).
 */
async function validate(jobId: string): Promise<void> {
  const accepted = await world.request('POST', `${base}/checklist-imports/${jobId}/validate`, {
    token: token(),
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);

  const db = createDatabase(pool);
  const queued = await db.execute(
    sql`SELECT data FROM pgboss.job
        WHERE name = ${QUEUES.checklistImport} AND data->>'jobId' = ${jobId}`,
  );
  const rows = (queued as unknown as { rows: Array<{ data: ChecklistImportJobData }> }).rows;
  expect(rows, 'the parse must be enqueued, not run in the request').toHaveLength(1);

  // The handler is fed the payload pg-boss actually stored, so a payload the worker
  // could not act on fails here rather than in production.
  await world.app.get(ChecklistImportWorker).handle(rows[0]!.data);
}

async function preview(jobId: string): Promise<ChecklistImportPreview> {
  const response = await world.request('GET', `${base}/checklist-imports/${jobId}/preview`, {
    token: token(),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as ChecklistImportPreview;
}

async function run(body: Buffer): Promise<ChecklistImportPreview> {
  const uploaded = await upload(body);
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  const jobId = (uploaded.body as ChecklistImportJob).id;
  await validate(jobId);
  return preview(jobId);
}

async function clearChecklists(): Promise<void> {
  await world.owner.query(`
    TRUNCATE checklist_import_row, checklist_import_sheet, checklist_import_job,
             checklist_question, checklist_version, checklist_template
    RESTART IDENTITY CASCADE;
  `);
}

describe('stage 1 — upload', () => {
  it('refuses a file that is not an .xlsx, by content rather than by name (§12.8)', async () => {
    const response = await upload(Buffer.from('total nonsense'), 'looks-legit.xlsx');
    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('IMPORT_FILE_REJECTED');
  });

  it('refuses an empty file', async () => {
    const response = await upload(Buffer.alloc(0));
    expect(response.status).toBe(400);
  });

  it('stores the workbook and records its checksum', async () => {
    const body = await validWorkbook();
    const response = await upload(body);
    expect(response.status).toBe(201);
    const job = response.body as ChecklistImportJob;
    expect(job.status).toBe('UPLOADED');
    expect(job.fileByteSize).toBe(body.byteLength);
    expect(job.fileChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(job.fileObjectKey).toBe(`import/${job.id}/workbook.xlsx`);
  });
});

describe('stages 2–5 on a valid workbook', () => {
  beforeEach(clearChecklists);

  it('parses the sheet, finds 50 questions and reports no findings', async () => {
    const result = await run(await validWorkbook('Premises'));

    expect(result.job.status).toBe('PREVIEW');
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0]).toMatchObject({
      sheetName: 'Premises',
      templateCode: 'PREMISES',
      questionCount: 50,
      severity: 'OK',
      templateId: null,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.rows).toHaveLength(50);
  });

  it('skips a sheet whose A1 is not a checklist title, and says why (Q7)', async () => {
    const result = await run(
      await buildWorkbook([
        { name: 'Monthly Zone Scores', title: 'MONTHLY ZONE-WISE 5S SCORE RECORD – 50 ZONES' },
        { name: 'Premises' },
      ]),
    );

    expect(result.sheets.map((sheet) => sheet.sheetName)).toEqual(['Premises']);
    expect(result.skippedSheets).toEqual([
      { name: 'Monthly Zone Scores', reason: expect.stringContaining('not a checklist') },
    ]);
  });

  it('writes nothing to checklist_version before COMMIT', async () => {
    await run(await validWorkbook('Premises'));
    const { rows } = await world.owner.query(
      'SELECT count(*)::int AS n FROM checklist_version',
    );
    expect(rows[0].n, 'preview is a dry run').toBe(0);
  });

  it('shows the diff as 50 additions when the template is new', async () => {
    const result = await run(await validWorkbook('Premises'));
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatchObject({
      currentVersionId: null,
      added: 50,
      removed: 0,
      changed: 0,
      unchanged: 0,
    });
  });
});

describe('stage 3 — validation findings', () => {
  beforeEach(clearChecklists);

  it('rejects a missing section', async () => {
    const result = await run(await buildWorkbook([{ name: 'Premises', dropSection: 3 }]));
    expect(result.sheets[0]?.severity).toBe('ERROR');
    expect(result.sheets[0]?.messages).toContain('Section S3_SHINE is missing from this sheet');
  });

  it('rejects 9 questions in a section', async () => {
    const result = await run(
      await buildWorkbook([{ name: 'Premises', counts: [9, 10, 10, 10, 10] }]),
    );
    expect(result.sheets[0]?.severity).toBe('ERROR');
    expect(result.sheets[0]?.messages).toContain(
      'Section S1_SORT has 9 questions; exactly 10 are required',
    );
  });

  it('rejects 11 questions in a section', async () => {
    const result = await run(
      await buildWorkbook([{ name: 'Premises', counts: [11, 10, 10, 10, 10] }]),
    );
    expect(result.sheets[0]?.severity).toBe('ERROR');
    expect(result.sheets[0]?.messages).toContain(
      'Section S1_SORT has 11 questions; exactly 10 are required',
    );
  });

  it('rejects a Sr. sequence with a gap, naming the row', async () => {
    const result = await run(
      await buildWorkbook([{ name: 'Premises', sr: (sr) => (sr >= 20 ? sr + 1 : sr) }]),
    );
    expect(result.sheets[0]?.severity).toBe('ERROR');
    expect(result.errors.some((row) => row.messages.join(' ').includes('expected 20'))).toBe(true);
    expect(result.errors[0]?.sourceRowNumber).toBeGreaterThan(6);
  });

  it('warns on a duplicate Check Point without rejecting the sheet', async () => {
    const result = await run(
      await buildWorkbook([
        { name: 'Premises', text: (section, position) => `S${section} Q${position === 2 ? 1 : position}` },
      ]),
    );
    expect(result.sheets[0]?.severity).toBe('WARNING');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.sheets[0]?.questionCount).toBe(50);
  });

  it('offers an annotated workbook whenever there is anything to report', async () => {
    const uploaded = await upload(await buildWorkbook([{ name: 'Premises', dropSection: 3 }]));
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);

    const report = await world.request(
      'GET',
      `${base}/checklist-imports/${jobId}/error-report`,
      { token: token() },
    );
    expect(report.status).toBe(200);
    // A real .xlsx, not an error page: the zip magic is the honest check.
    expect(Buffer.from(report.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });

  it('has no annotated workbook when the file was clean', async () => {
    const uploaded = await upload(await validWorkbook('Premises'));
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);

    const report = await world.request(
      'GET',
      `${base}/checklist-imports/${jobId}/error-report`,
      { token: token() },
    );
    expect(report.status).toBe(404);
  });

  it('refuses to commit a sheet that has errors', async () => {
    const uploaded = await upload(await buildWorkbook([{ name: 'Premises', dropSection: 3 }]));
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);

    const response = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
      token: token(),
      body: {},
    });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('IMPORT_VALIDATION_FAILED');
  });
});

describe('stage 4 — duplicate detection', () => {
  beforeEach(clearChecklists);

  async function importAndPublish(body: Buffer): Promise<CommitChecklistImportResponse> {
    const uploaded = await upload(body);
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);
    const committed = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
      token: token(),
      body: { publish: true },
    });
    expect(committed.status, JSON.stringify(committed.body)).toBe(201);
    return committed.body as CommitChecklistImportResponse;
  }

  it('blocks a byte-identical re-import of the published version', async () => {
    const body = await validWorkbook('Premises');
    await importAndPublish(body);

    const second = await run(body);
    expect(second.sheets[0]?.duplicateIsPublished).toBe(true);
    expect(second.sheets[0]?.messages.join(' ')).toContain('No changes to import');

    const uploaded = await upload(body);
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);
    const commit = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
      token: token(),
      body: {},
    });
    expect(commit.status).toBe(409);
    expect((commit.body as { code: string }).code).toBe('IMPORT_NO_CHANGES');
  });

  it('warns that an older version’s wording would be reverted to', async () => {
    const v1 = await validWorkbook('Premises');
    await importAndPublish(v1);

    // v2 reworks one question, so v1's content is now a superseded version.
    const v2 = await buildWorkbook([
      {
        name: 'Premises',
        text: (section, position) =>
          section === 1 && position === 1
            ? 'Premises S1 Q1 (revised)'
            : `Premises S${section} Q${position}`,
      },
    ]);
    await importAndPublish(v2);

    const reverting = await run(v1);
    expect(reverting.sheets[0]?.duplicateIsPublished).toBe(false);
    expect(reverting.sheets[0]?.duplicateOfVersionId).not.toBeNull();
    expect(reverting.sheets[0]?.duplicateOfVersionNumber).toBe(1);
    expect(reverting.sheets[0]?.messages.join(' ')).toContain('would revert to that wording');
  });

  it('shows a reworded question as CHANGED in the preview diff', async () => {
    await importAndPublish(await validWorkbook('Premises'));

    const result = await run(
      await buildWorkbook([
        {
          name: 'Premises',
          text: (section, position) =>
            section === 2 && position === 5
              ? 'Premises S2 Q5 (reworded)'
              : `Premises S${section} Q${position}`,
        },
      ]),
    );

    expect(result.diffs[0]).toMatchObject({
      currentVersionNumber: 1,
      changed: 1,
      unchanged: 49,
      added: 0,
      removed: 0,
    });
  });
});

describe('stage 6 — commit and publish', () => {
  beforeEach(clearChecklists);

  it('creates a DRAFT version with 50 questions and links it back to the job', async () => {
    const uploaded = await upload(await validWorkbook('Premises'));
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);

    const committed = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
      token: token(),
      body: {},
    });
    expect(committed.status).toBe(201);

    const { versions } = committed.body as CommitChecklistImportResponse;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      status: 'DRAFT',
      versionNumber: 1,
      totalQuestions: 50,
      questionsPerSection: 10,
      sourceImportJobId: jobId,
      templateCode: 'PREMISES',
    });

    const detail = await world.request('GET', `${base}/checklist-versions/${versions[0]!.id}`, {
      token: token(),
    });
    const questions = (detail.body as ChecklistVersionDetail).questions;
    expect(questions).toHaveLength(50);
    expect(questions[0]).toMatchObject({ section: 'S1_SORT', orderInSection: 1, globalOrder: 1 });
    expect(questions[49]).toMatchObject({
      section: 'S5_SUSTAIN',
      orderInSection: 10,
      globalOrder: 50,
    });
  });

  it('marks the job COMMITTED and refuses a second commit', async () => {
    const uploaded = await upload(await validWorkbook('Premises'));
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);

    await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
      token: token(),
      body: {},
    });

    const again = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
      token: token(),
      body: {},
    });
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe('IMPORT_NOT_PREVIEWED');
  });

  it('commits only the sheets that were selected', async () => {
    const uploaded = await upload(
      await buildWorkbook([{ name: 'Premises' }, { name: 'Office' }]),
    );
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);
    const previewed = await preview(jobId);

    const office = previewed.sheets.find((sheet) => sheet.sheetName === 'Office')!;
    const committed = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
      token: token(),
      body: { sheetIds: [office.id] },
    });

    const { versions } = committed.body as CommitChecklistImportResponse;
    expect(versions.map((version) => version.templateCode)).toEqual(['OFFICE']);
  });
});

describe('the real department workbook', () => {
  beforeEach(clearChecklists);

  it('imports all nine templates from docs/requirements with zero errors', async () => {
    const body = await readFile(
      resolve(__dirname, '..', '..', '..', 'docs', 'requirements', '5S_lean_audit_data_1.xlsx'),
    );

    const uploaded = await upload(body, '5S_lean_audit_data_1.xlsx');
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);
    const result = await preview(jobId);

    // Zero findings of either kind. The business's real file is correct as written, and
    // the importer must not manufacture warnings by "normalising" its punctuation.
    expect(result.job.errorCount).toBe(0);
    expect(result.job.warningCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.sheets.every((sheet) => sheet.severity === 'OK')).toBe(true);

    // Workbook order, exactly as HANDOFF.md §3.2 lists it (R-6a).
    expect(result.sheets.map((sheet) => sheet.templateCode)).toEqual([
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
    expect(result.sheets.every((sheet) => sheet.questionCount === 50)).toBe(true);

    // The three legacy planning tabs, skipped rather than half-imported (Q7).
    expect(result.skippedSheets.map((sheet) => sheet.name)).toEqual([
      '5S Audit Team',
      'Audit Schedule',
      'Monthly Zone Scores',
    ]);

    const committed = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
      token: token(),
      body: { publish: true },
    });
    expect(committed.status, JSON.stringify(committed.body)).toBe(201);
    const { versions } = committed.body as CommitChecklistImportResponse;
    expect(versions).toHaveLength(9);
    expect(versions.every((version) => version.status === 'PUBLISHED')).toBe(true);
    expect(versions.every((version) => version.totalQuestions === 50)).toBe(true);
  });
});
