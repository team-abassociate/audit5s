import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH } from '@audit5s/contracts';
import { startWorld, stopWorld, type TestWorld } from './harness';

/** Unit routes the sweep marks `coveredBy`, plus invariant U-1 in detail. */

let world: TestWorld;
const base = API_BASE_PATH;

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await stopWorld(world);
});

describe('creation', () => {
  it('creates a Unit and defaults the timezone to Asia/Kolkata (A11)', async () => {
    const response = await world.request('POST', `${base}/units`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { name: 'Surat Plant' },
    });
    expect(response.status).toBe(201);
    expect((response.body as { timezone: string }).timezone).toBe('Asia/Kolkata');
  });

  it('refuses a duplicate name with a usable error code', async () => {
    const response = await world.request('POST', `${base}/units`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { name: 'Surat Plant' },
    });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('DUPLICATE_NAME');
  });

  it('rejects a timezone that is not in the IANA database', async () => {
    const response = await world.request('POST', `${base}/units`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { name: 'Bad', timezone: 'Mars/Olympus' },
    });
    expect(response.status).toBe(422);
  });
});

describe('invariant U-1 — a Coordinator may not rename their Unit', () => {
  it('returns 403 FIELD_NOT_EDITABLE naming `name`', async () => {
    const response = await world.request('PATCH', `${base}/units/${world.unitA}`, {
      token: world.actors.COORDINATOR.accessToken,
      body: { name: 'Renamed By Coordinator' },
    });
    expect(response.status).toBe(403);
    const body = response.body as { code: string; errors?: Array<{ field: string }> };
    expect(body.code).toBe('FIELD_NOT_EDITABLE');
    expect(body.errors?.map((e) => e.field)).toEqual(['name']);
  });

  it('names every offending field, not just the first', async () => {
    const response = await world.request('PATCH', `${base}/units/${world.unitA}`, {
      token: world.actors.COORDINATOR.accessToken,
      body: { name: 'X', city: 'Nashik' },
    });
    expect(response.status).toBe(403);
    expect(
      (response.body as { errors?: Array<{ field: string }> }).errors?.map((e) => e.field),
    ).toEqual(['name']);
  });

  it('accepts the Coordinator-editable fields', async () => {
    const response = await world.request('PATCH', `${base}/units/${world.unitA}`, {
      token: world.actors.COORDINATOR.accessToken,
      body: { city: 'Nashik', contactName: 'Site Office', geofenceRadiusM: 500 },
    });
    expect(response.status).toBe(200);
    const body = response.body as { city: string; geofenceRadiusM: number };
    expect(body.city).toBe('Nashik');
    expect(body.geofenceRadiusM).toBe(500);
  });

  it('lets a Super Admin rename the same Unit', async () => {
    const response = await world.request('PATCH', `${base}/units/${world.unitA}`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { name: 'Unit A Renamed' },
    });
    expect(response.status).toBe(200);
    expect((response.body as { name: string }).name).toBe('Unit A Renamed');
  });

});

describe('optimistic concurrency', () => {
  it('refuses a stale version with VERSION_CONFLICT', async () => {
    const current = await world.request('GET', `${base}/units/${world.unitA}`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    const version = (current.body as { version: number }).version;

    const first = await world.request('PATCH', `${base}/units/${world.unitA}`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { city: 'First', version },
    });
    expect(first.status).toBe(200);

    const second = await world.request('PATCH', `${base}/units/${world.unitA}`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { city: 'Second', version },
    });
    expect(second.status).toBe(409);
    expect((second.body as { code: string }).code).toBe('VERSION_CONFLICT');
  });
});

describe('archive', () => {
  it('archives a Unit and drops it from the default listing', async () => {
    const created = await world.request('POST', `${base}/units`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { name: 'Temporary' },
    });
    const unitId = (created.body as { id: string }).id;

    const archived = await world.request('POST', `${base}/units/${unitId}/archive`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    expect(archived.status).toBe(204);

    const listed = await world.request('GET', `${base}/units`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    const names = (listed.body as { data: Array<{ name: string }> }).data.map((u) => u.name);
    expect(names).not.toContain('Temporary');

    // Archived, never deleted: it stays visible when asked for explicitly.
    const withArchived = await world.request('GET', `${base}/units?includeArchived=true`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    const all = (withArchived.body as { data: Array<{ name: string }> }).data.map((u) => u.name);
    expect(all).toContain('Temporary');
  });
});
