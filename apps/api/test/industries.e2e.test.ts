import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH, type Industry } from '@audit5s/contracts';
import { startWorld, stopWorld, type TestWorld } from './harness';

/**
 * Industries (0018) — the routes the authorization sweep marks `coveredBy`, because a
 * write needs a real body, plus the rules that only show up against a live database.
 */

let world: TestWorld;
const base = API_BASE_PATH;

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await stopWorld(world);
});

const asSuperAdmin = () => world.actors.SUPER_ADMIN.accessToken;

describe('the sector the migration named', () => {
  it('ships Engineering, already tagging the catalogue', async () => {
    const response = await world.request('GET', `${base}/industries`, { token: asSuperAdmin() });
    expect(response.status).toBe(200);

    // 0018 creates this row itself rather than leaving a deployment to migrate into an
    // empty sector list beside a catalogue that plainly belongs to one.
    const engineering = (response.body as Industry[]).find((row) => row.code === 'ENGINEERING');
    expect(engineering, 'the migration must seed ENGINEERING').toBeDefined();
    expect(engineering!.archivedAt).toBeNull();
  });

  it('is readable by every role — it labels a catalogue they all read (D2)', async () => {
    for (const role of ['CONSULTANT', 'COORDINATOR', 'ZONE_LEADER'] as const) {
      const response = await world.request('GET', `${base}/industries`, {
        token: world.actors[role].accessToken,
      });
      expect(response.status, role).toBe(200);
    }
  });
});

describe('managing sectors', () => {
  let hospitalId = '';

  it('creates one, and only for a Super Admin', async () => {
    for (const role of ['CONSULTANT', 'COORDINATOR', 'ZONE_LEADER'] as const) {
      const refused = await world.request('POST', `${base}/industries`, {
        token: world.actors[role].accessToken,
        body: { code: 'SNEAK', name: 'Sneak' },
      });
      expect(refused.status, role).toBe(403);
    }

    const created = await world.request('POST', `${base}/industries`, {
      token: asSuperAdmin(),
      body: { code: 'HOSPITAL', name: 'Hospital', description: 'Wards, theatres, pharmacy.' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const body = created.body as Industry;
    expect(body.code).toBe('HOSPITAL');
    // Nothing points at it yet, which is what makes it archivable below.
    expect(body.templateCount).toBe(0);
    expect(body.unitCount).toBe(0);
    hospitalId = body.id;
  });

  it('refuses a duplicate code with a usable error', async () => {
    const response = await world.request('POST', `${base}/industries`, {
      token: asSuperAdmin(),
      body: { code: 'HOSPITAL', name: 'Hospital again' },
    });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('DUPLICATE_CODE');
  });

  it('renames one without letting its code move', async () => {
    const response = await world.request('PATCH', `${base}/industries/${hospitalId}`, {
      token: asSuperAdmin(),
      body: { name: 'Healthcare' },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as Industry).name).toBe('Healthcare');
    // The code is absent from the update contract: templates and Units point at the row by
    // id, but people recognise it by its code, and a code that can change means something
    // different in two places at once.
    expect((response.body as Industry).code).toBe('HOSPITAL');
  });

  it('archives an unused one, and answers with the archived row', async () => {
    const response = await world.request('DELETE', `${base}/industries/${hospitalId}`, {
      token: asSuperAdmin(),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as Industry).archivedAt).not.toBeNull();
  });

  it('hides an archived one unless it is asked for — nothing is deleted (D8)', async () => {
    const hidden = await world.request('GET', `${base}/industries`, { token: asSuperAdmin() });
    expect((hidden.body as Industry[]).some((row) => row.id === hospitalId)).toBe(false);

    const shown = await world.request('GET', `${base}/industries?includeArchived=true`, {
      token: asSuperAdmin(),
    });
    expect((shown.body as Industry[]).some((row) => row.id === hospitalId)).toBe(true);
  });

  it('frees the code once archived, so a new sector may reuse it', async () => {
    // `industry_code_active_key` is partial on `archived_at IS NULL` precisely for this.
    const response = await world.request('POST', `${base}/industries`, {
      token: asSuperAdmin(),
      body: { code: 'HOSPITAL', name: 'Hospital, second attempt' },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });
});

describe('an industry in use', () => {
  it('refuses to archive, and says what is still pointing at it', async () => {
    const list = await world.request('GET', `${base}/industries`, { token: asSuperAdmin() });
    const engineering = (list.body as Industry[]).find((row) => row.code === 'ENGINEERING')!;

    // The seeded catalogue is tagged ENGINEERING, so this is the in-use case without any
    // setup — and the one that matters, because archiving it would leave every template
    // labelled with something no screen lists.
    expect(engineering.templateCount).toBeGreaterThan(0);

    const response = await world.request('DELETE', `${base}/industries/${engineering.id}`, {
      token: asSuperAdmin(),
    });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('RESOURCE_IN_USE');
    // The message names the counts, because "cannot archive" without them leaves the
    // reader to go hunting for what they would have to move first.
    expect((response.body as { detail: string }).detail).toMatch(/checklist template/);
  });
});

describe('what a sector narrows', () => {
  it('still offers unclassified templates when filtering to one industry', async () => {
    const list = await world.request('GET', `${base}/industries`, { token: asSuperAdmin() });
    const fresh = (list.body as Industry[]).find((row) => row.code === 'HOSPITAL')!;

    const filtered = await world.request(
      'GET',
      `${base}/checklist-templates?limit=200&industryId=${fresh.id}`,
      { token: asSuperAdmin() },
    );
    expect(filtered.status).toBe(200);

    // Every seeded template is ENGINEERING, so a Hospital filter returns none of them —
    // and would return any template nobody had classified. That fallback is the reason
    // adding a second sector does not empty the catalogue for every Unit at once.
    const rows = (filtered.body as { data: Array<{ industryId: string | null }> }).data;
    for (const row of rows) {
      expect(row.industryId === null || row.industryId === fresh.id).toBe(true);
    }
  });
});
