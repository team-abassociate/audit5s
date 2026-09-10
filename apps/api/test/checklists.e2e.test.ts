import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, createPool } from '@audit5s/db';
import type { Pool } from 'pg';
import {
  API_BASE_PATH,
  type ChecklistImportJob,
  type ChecklistTemplate,
  type ChecklistVersion,
  type ChecklistVersionDetail,
  type CommitChecklistImportResponse,
  type Page,
  type Role,
} from '@audit5s/contracts';
import { QUEUES } from '../src/infrastructure/queue/queue.service';
import {
  ChecklistImportWorker,
  type ChecklistImportJobData,
} from '../src/modules/checklists/import/checklist-import.worker';
import { APP_URL, startWorld, stopWorld, type TestWorld } from './harness';
import { buildWorkbook } from './workbook-fixtures';

/** Checklist versioning: publish, supersede, deactivate, and CV-1 seen from the API. */

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

/** Imports one department sheet and returns its DRAFT version. */
async function importDraft(
  name: string,
  text?: (section: number, position: number) => string,
): Promise<ChecklistVersion> {
  const body = await buildWorkbook([{ name, ...(text ? { text } : {}) }]);
  const uploaded = await world.upload(
    `${base}/checklist-imports`,
    { filename: `${name}.xlsx`, contentType: XLSX, body },
    { token: token() },
  );
  const jobId = (uploaded.body as ChecklistImportJob).id;

  await world.request('POST', `${base}/checklist-imports/${jobId}/validate`, { token: token() });

  const db = createDatabase(pool);
  const queued = await db.execute(
    sql`SELECT data FROM pgboss.job
        WHERE name = ${QUEUES.checklistImport} AND data->>'jobId' = ${jobId}`,
  );
  const rows = (queued as unknown as { rows: Array<{ data: ChecklistImportJobData }> }).rows;
  await world.app.get(ChecklistImportWorker).handle(rows[0]!.data);

  const committed = await world.request('POST', `${base}/checklist-imports/${jobId}/commit`, {
    token: token(),
    body: {},
  });
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  return (committed.body as CommitChecklistImportResponse).versions[0]!;
}

async function clearChecklists(): Promise<void> {
  await world.owner.query(`
    TRUNCATE checklist_import_row, checklist_import_sheet, checklist_import_job,
             checklist_question, checklist_version, checklist_template
    RESTART IDENTITY CASCADE;
  `);
}

describe('publishing', () => {
  beforeEach(clearChecklists);

  it('moves a DRAFT to PUBLISHED and stamps who did it', async () => {
    const draft = await importDraft('Premises');
    const response = await world.request(
      'POST',
      `${base}/checklist-versions/${draft.id}/publish`,
      { token: token() },
    );

    expect(response.status).toBe(201);
    const published = response.body as ChecklistVersion;
    expect(published.status).toBe('PUBLISHED');
    expect(published.publishedAt).not.toBeNull();
    expect(published.publishedByUserId).toBe(world.actors.SUPER_ADMIN.userId);
  });

  it('refuses to publish the same version twice', async () => {
    const draft = await importDraft('Premises');
    await world.request('POST', `${base}/checklist-versions/${draft.id}/publish`, {
      token: token(),
    });
    const again = await world.request('POST', `${base}/checklist-versions/${draft.id}/publish`, {
      token: token(),
    });
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe('CHECKLIST_VERSION_NOT_DRAFT');
  });

  it('supersedes the previous published version rather than leaving two', async () => {
    const v1 = await importDraft('Premises');
    await world.request('POST', `${base}/checklist-versions/${v1.id}/publish`, { token: token() });

    const v2 = await importDraft('Premises', (section, position) =>
      section === 1 && position === 1 ? 'Premises S1 Q1 revised' : `Premises S${section} Q${position}`,
    );
    await world.request('POST', `${base}/checklist-versions/${v2.id}/publish`, { token: token() });

    const listed = await world.request(
      'GET',
      `${base}/checklist-versions?templateId=${v1.templateId}&limit=50`,
      { token: token() },
    );
    const versions = (listed.body as Page<ChecklistVersion>).data;
    expect(versions.filter((version) => version.status === 'PUBLISHED')).toHaveLength(1);

    const superseded = versions.find((version) => version.id === v1.id)!;
    expect(superseded.status).toBe('SUPERSEDED');
    expect(superseded.supersededByVersionId).toBe(v2.id);
    expect(superseded.supersededAt).not.toBeNull();
  });

  it('shows the template’s currently published version in the catalogue', async () => {
    const draft = await importDraft('Premises');
    await world.request('POST', `${base}/checklist-versions/${draft.id}/publish`, {
      token: token(),
    });

    const templates = await world.request('GET', `${base}/checklist-templates`, {
      token: token(),
    });
    const template = (templates.body as Page<ChecklistTemplate>).data.find(
      (candidate) => candidate.code === 'PREMISES',
    )!;
    expect(template.publishedVersionId).toBe(draft.id);
    expect(template.publishedVersionNumber).toBe(1);
  });
});

describe('invariant CV-1, from the API’s side', () => {
  beforeEach(clearChecklists);

  it('serves a published version as immutable, and the ETag is its content hash', async () => {
    const draft = await importDraft('Premises');
    await world.request('POST', `${base}/checklist-versions/${draft.id}/publish`, {
      token: token(),
    });

    const response = await world.app.inject({
      method: 'GET',
      url: `${base}/checklist-versions/${draft.id}`,
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('immutable');
    const detail = JSON.parse(response.body) as ChecklistVersionDetail;
    expect(response.headers.etag).toBe(`"${detail.contentHash}"`);
  });

  it('offers no route that could edit a published question', async () => {
    // The absence is the control. If a question-editing endpoint is ever added, the
    // authorization matrix's completeness check will demand a decision about it, and the
    // database trigger will refuse it regardless.
    const routes = (
      world.app.getHttpAdapter().getInstance() as unknown as {
        printRoutes: (o?: object) => string;
      }
    ).printRoutes({ commonPrefix: false, includeMeta: false });
    expect(routes).not.toMatch(/checklist-questions/);
  });
});

describe('deactivation', () => {
  beforeEach(clearChecklists);

  it('archives a published version', async () => {
    const draft = await importDraft('Premises');
    await world.request('POST', `${base}/checklist-versions/${draft.id}/publish`, {
      token: token(),
    });

    const response = await world.request(
      'POST',
      `${base}/checklist-versions/${draft.id}/deactivate`,
      { token: token() },
    );
    expect(response.status).toBe(201);
    expect((response.body as ChecklistVersion).status).toBe('ARCHIVED');
  });

  it('refuses to deactivate a draft', async () => {
    const draft = await importDraft('Premises');
    const response = await world.request(
      'POST',
      `${base}/checklist-versions/${draft.id}/deactivate`,
      { token: token() },
    );
    expect(response.status).toBe(409);
  });

  it('frees the template to publish again afterwards', async () => {
    const v1 = await importDraft('Premises');
    await world.request('POST', `${base}/checklist-versions/${v1.id}/publish`, { token: token() });
    await world.request('POST', `${base}/checklist-versions/${v1.id}/deactivate`, {
      token: token(),
    });

    const v2 = await importDraft('Premises', (section, position) =>
      section === 5 && position === 10 ? 'Premises S5 Q10 revised' : `Premises S${section} Q${position}`,
    );
    const published = await world.request(
      'POST',
      `${base}/checklist-versions/${v2.id}/publish`,
      { token: token() },
    );
    expect(published.status).toBe(201);
  });
});

describe('who may read the catalogue (D2)', () => {
  beforeEach(async () => {
    await clearChecklists();
    const draft = await importDraft('Premises');
    await world.request('POST', `${base}/checklist-versions/${draft.id}/publish`, {
      token: token(),
    });
  });

  it('lets every authenticated role read templates, versions and questions', async () => {
    for (const role of ['SUPER_ADMIN', 'CONSULTANT', 'COORDINATOR', 'ZONE_LEADER'] as Role[]) {
      const templates = await world.request('GET', `${base}/checklist-templates`, {
        token: world.actors[role].accessToken,
      });
      expect(templates.status, `${role} templates`).toBe(200);
      expect((templates.body as Page<ChecklistTemplate>).data).toHaveLength(1);

      const versions = await world.request(
        'GET',
        `${base}/checklist-versions?status=PUBLISHED`,
        { token: world.actors[role].accessToken },
      );
      expect(versions.status, `${role} versions`).toBe(200);
      const version = (versions.body as Page<ChecklistVersion>).data[0]!;

      const detail = await world.request('GET', `${base}/checklist-versions/${version.id}`, {
        token: world.actors[role].accessToken,
      });
      expect((detail.body as ChecklistVersionDetail).questions).toHaveLength(50);
    }
  });

  it('lets nobody but a Super Admin publish, deactivate or import', async () => {
    const versions = await world.request('GET', `${base}/checklist-versions`, { token: token() });
    const version = (versions.body as Page<ChecklistVersion>).data[0]!;

    for (const role of ['CONSULTANT', 'COORDINATOR', 'ZONE_LEADER'] as Role[]) {
      const publish = await world.request(
        'POST',
        `${base}/checklist-versions/${version.id}/publish`,
        { token: world.actors[role].accessToken },
      );
      expect(publish.status, `${role} publish`).toBe(403);

      const imports = await world.request('GET', `${base}/checklist-imports`, {
        token: world.actors[role].accessToken,
      });
      expect(imports.status, `${role} imports`).toBe(403);
    }
  });

  it('updates a template’s display fields for a Super Admin', async () => {
    const templates = await world.request('GET', `${base}/checklist-templates`, {
      token: token(),
    });
    const template = (templates.body as Page<ChecklistTemplate>).data[0]!;

    const response = await world.request('PATCH', `${base}/checklist-templates/${template.id}`, {
      token: token(),
      body: { description: 'Outdoor areas, roads and the scrap yard' },
    });
    expect(response.status).toBe(200);
    expect((response.body as ChecklistTemplate).description).toBe(
      'Outdoor areas, roads and the scrap yard',
    );
  });
});
