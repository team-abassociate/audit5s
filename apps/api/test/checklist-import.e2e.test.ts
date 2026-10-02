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
  type ChecklistTemplate,
  type Industry,
  type ChecklistVersionDetail,
  type CommitChecklistImportResponse,
} from '@audit5s/contracts';
import { grantFor, type ScopeContext } from '@audit5s/domain';
import { QUEUES } from '../src/infrastructure/queue/queue.service';
import { ChecklistImportRepository } from '../src/modules/checklists/import/checklist-import.repository';
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
async function validate(jobId: string, industryIds?: string[]): Promise<void> {
  const accepted = await world.request('POST', `${base}/checklist-imports/${jobId}/validate`, {
    token: token(),
    ...(industryIds ? { body: { industryIds } } : {}),
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

describe('importing for an industry (0042)', () => {
  beforeEach(clearChecklists);

  let hospitalId = '';
  beforeAll(async () => {
    const created = await world.request('POST', `${base}/industries`, {
      token: token(),
      body: { code: 'HOSPITAL_IMPORT', name: 'Hospital (import test)' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    hospitalId = (created.body as Industry).id;
  });

  async function importAndCommit(industryIds: string[], reword = false) {
    const workbook = reword
      ? await buildWorkbook([
          { name: 'Office', text: (section, position) => `Reworded office check ${section}.${position}` },
        ])
      : await validWorkbook('Office');
    const uploaded = await upload(workbook);
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId, industryIds);
    const shown = await preview(jobId);
    const committed = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
      token: token(),
      body: {},
    });
    expect(committed.status, JSON.stringify(committed.body)).toBe(201);
    return { preview: shown, versions: (committed.body as CommitChecklistImportResponse).versions };
  }

  it('records the industries on the job, and labels the checklist it makes', async () => {
    const { preview: shown, versions } = await importAndCommit([hospitalId]);
    expect(shown.job.industryIds).toEqual([hospitalId]);

    const template = await world.request('GET', `${base}/checklist-templates/${versions[0]!.templateId}`, {
      token: token(),
    });
    expect((template.body as ChecklistTemplate).industries.map((row) => row.id)).toEqual([hospitalId]);
  });

  it('makes a separate checklist when the same sheet is imported for another industry', async () => {
    const forEveryone = await importAndCommit([]);
    const forHospital = await importAndCommit([hospitalId], true);

    expect(forHospital.preview.sheets[0]!.templateId).toBeNull();
    expect(forHospital.versions[0]!.templateId).not.toBe(forEveryone.versions[0]!.templateId);
    expect(forHospital.versions[0]!.versionNumber).toBe(1);
    // `code` stays unique; the industry is appended rather than colliding.
    expect(forEveryone.versions[0]!.templateCode).toBe('OFFICE');
    expect(forHospital.versions[0]!.templateCode).toBe('OFFICE_HOSPITAL_IMPORT');
  });

  it('makes a new version when the sheet and the industries both match', async () => {
    const first = await importAndCommit([hospitalId]);
    const second = await importAndCommit([hospitalId], true);

    // What the matcher sees, through its own query under a Super Admin scope — printed
    // if it did not match. (The owner connection cannot see the links: FORCE RLS.)
    const grant = grantFor('SUPER_ADMIN', 'checklist_import:preview')!;
    const seen = await world.app.get(ChecklistImportRepository).templatesBySheetCode(
      {
        actor: {
          userId: world.actors.SUPER_ADMIN.userId,
          role: 'SUPER_ADMIN',
          activeUnitId: null,
          unitIds: [],
          deviceId: null,
        },
        resolver: grant.resolver,
      } as ScopeContext,
      ['OFFICE'],
    );
    expect(
      second.preview.sheets[0]!.templateId,
      JSON.stringify({
        seen: seen.map((row) => ({ ...row, type: typeof row.industryIds, isArray: Array.isArray(row.industryIds) })),
        hospitalId,
        job: second.preview.job.industryIds,
        jobType: typeof second.preview.job.industryIds,
      }),
    ).toBe(first.versions[0]!.templateId);
    expect(second.versions[0]!.versionNumber).toBe(2);
  });

  it('refuses an archived or unknown industry before anything is enqueued', async () => {
    const uploaded = await upload(await validWorkbook('Office'));
    const jobId = (uploaded.body as ChecklistImportJob).id;
    const refused = await world.request('POST', `${base}/checklist-imports/${jobId}/validate`, {
      token: token(),
      body: { industryIds: ['00000000-0000-4000-8000-000000000000'] },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
  });
});

describe('Hindi and Marathi columns (0037)', () => {
  beforeEach(async () => {
    await clearChecklists();
    // The synthetic questions' translations; 0036's seeded rows are left alone.
    await world.owner.query(
      `DELETE FROM checklist_question_translation WHERE source_text LIKE 'Premises S%'`,
    );
  });

  const BOTH = {
    headers: ['Check Point (Hindi)', 'Check Point (Marathi)'],
    cells: (section: number, position: number) => [
      `परिसर S${section} प्रश्न ${position}`,
      `परिसर S${section} प्रश्न ${position} (मराठी)`,
    ],
  };

  async function commit(jobId: string, body: object = { publish: true }) {
    const committed = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
      token: token(),
      body,
    });
    expect(committed.status, JSON.stringify(committed.body)).toBe(201);
    return committed.body as CommitChecklistImportResponse;
  }

  async function importAndPublish(body: Buffer): Promise<CommitChecklistImportResponse> {
    const uploaded = await upload(body);
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);
    return commit(jobId);
  }

  async function questionsOf(versionId: string) {
    const detail = await world.request('GET', `${base}/checklist-versions/${versionId}`, {
      token: token(),
    });
    return (detail.body as ChecklistVersionDetail).questions;
  }

  it('reads the columns in the preview, and saves them with the new version', async () => {
    const body = await buildWorkbook([{ name: 'Premises', translations: BOTH }]);
    const previewed = await run(body);

    expect(previewed.sheets[0]?.severity).toBe('OK');
    expect(previewed.sheets[0]?.translationCounts).toEqual({ hi: 50, mr: 50 });
    expect(previewed.rows[0]?.parsedTranslations).toEqual({
      hi: 'परिसर S1 प्रश्न 1',
      mr: 'परिसर S1 प्रश्न 1 (मराठी)',
    });

    const committed = await importAndPublish(body);
    expect(committed.translationsSaved).toBe(100);

    const questions = await questionsOf(committed.versions[0]!.id);
    expect(questions[0]).toMatchObject({
      text: 'Premises S1 Q1',
      translations: { hi: 'परिसर S1 प्रश्न 1', mr: 'परिसर S1 प्रश्न 1 (मराठी)' },
    });
  });

  it('saves translations for the published English without making a new version', async () => {
    const published = await importAndPublish(await validWorkbook('Premises'));
    const versionId = published.versions[0]!.id;

    const body = await buildWorkbook([{ name: 'Premises', translations: BOTH }]);
    const previewed = await run(body);
    expect(previewed.sheets[0]?.duplicateIsPublished).toBe(true);
    // A sheet that only adds translations is not "no changes", and is not a warning.
    expect(previewed.sheets[0]?.severity).toBe('OK');
    expect(previewed.sheets[0]?.messages.join(' ')).toContain('saves its translations');

    const uploaded = await upload(body);
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);
    const committed = await commit(jobId);
    expect(committed.versions).toEqual([]);
    expect(committed.translationsSaved).toBe(100);

    // The version audits are pinned to is the same one, now with its Hindi and Marathi.
    const questions = await questionsOf(versionId);
    expect(questions[49]?.translations).toEqual({
      hi: 'परिसर S5 प्रश्न 10',
      mr: 'परिसर S5 प्रश्न 10 (मराठी)',
    });
    const versions = await world.owner.query(
      `SELECT count(*)::int AS n FROM checklist_version`,
    );
    expect(versions.rows[0]?.n).toBe(1);
  });

  it('keeps a translation whose cell is blank, and replaces one that was changed', async () => {
    const published = await importAndPublish(
      await buildWorkbook([{ name: 'Premises', translations: BOTH }]),
    );

    await importAndPublish(
      await buildWorkbook([
        {
          name: 'Premises',
          translations: {
            headers: ['Hindi'],
            cells: (section, position) =>
              section === 1 && position === 1
                ? [null]
                : section === 1 && position === 2
                  ? ['नया अनुवाद']
                  : [`परिसर S${section} प्रश्न ${position}`],
          },
        },
      ]),
    );

    const questions = await questionsOf(published.versions[0]!.id);
    expect(questions[0]?.translations?.hi).toBe('परिसर S1 प्रश्न 1');
    expect(questions[1]?.translations?.hi).toBe('नया अनुवाद');
    // The Marathi column was absent from the second file, so every Marathi row is untouched.
    expect(questions[1]?.translations?.mr).toBe('परिसर S1 प्रश्न 2 (मराठी)');
  });

  it('still blocks a re-import that brings neither new wording nor translations', async () => {
    const body = await validWorkbook('Premises');
    await importAndPublish(body);

    const uploaded = await upload(body);
    const jobId = (uploaded.body as ChecklistImportJob).id;
    await validate(jobId);
    const again = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
      token: token(),
      body: {},
    });
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe('IMPORT_NO_CHANGES');
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

    // Workbook order, exactly as R-6a lists it.
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
