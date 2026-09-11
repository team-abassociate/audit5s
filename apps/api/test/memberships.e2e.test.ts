import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH } from '@audit5s/contracts';
import { startWorld, stopWorld, type TestWorld } from './harness';

let world: TestWorld;
const base = API_BASE_PATH;

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await stopWorld(world);
});

describe('assignment', () => {
  it('assigns a Consultant to a second Unit and widens their scope at once', async () => {
    const response = await world.request('POST', `${base}/units/${world.unitB}/memberships`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { userId: world.actors.CONSULTANT.userId },
    });
    expect(response.status).toBe(201);

    const units = await world.request('GET', `${base}/units`, {
      token: world.actors.CONSULTANT.accessToken,
    });
    expect((units.body as { data: unknown[] }).data).toHaveLength(2);
  });

  it('refuses a role that disagrees with the user’s own', async () => {
    const response = await world.request('POST', `${base}/units/${world.unitB}/memberships`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { userId: world.actors.ZONE_LEADER.userId, role: 'CONSULTANT' },
    });
    // A membership whose role disagrees would corrupt every predicate built on it.
    expect(response.status).toBe(422);
  });

  it('refuses to give a Super Admin a Unit — their scope is organization-wide', async () => {
    const response = await world.request('POST', `${base}/units/${world.unitA}/memberships`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { userId: world.actors.SUPER_ADMIN.userId },
    });
    expect(response.status).toBe(409);
  });

  it('refuses a duplicate active assignment to the same Unit', async () => {
    const response = await world.request('POST', `${base}/units/${world.unitA}/memberships`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { userId: world.actors.CONSULTANT.userId },
    });
    expect(response.status).toBe(409);
  });

  it('is refused for every role but SUPER_ADMIN', async () => {
    for (const role of ['CONSULTANT', 'COORDINATOR', 'ZONE_LEADER'] as const) {
      const response = await world.request('POST', `${base}/units/${world.unitA}/memberships`, {
        token: world.actors[role].accessToken,
        body: { userId: world.actors.ZONE_LEADER.userId },
      });
      expect(response.status, `${role} must not assign memberships`).toBe(403);
    }
  });
});

describe('revocation', () => {
  it('is a soft revoke that keeps the row', async () => {
    const list = await world.request(
      'GET',
      `${base}/memberships?userId=${world.actors.CONSULTANT.userId}&unitId=${world.unitB}`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    const membership = (list.body as { data: Array<{ id: string }> }).data[0];
    expect(membership).toBeDefined();

    const revoked = await world.request(
      'DELETE',
      `${base}/units/${world.unitB}/memberships/${membership!.id}`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    expect(revoked.status).toBe(204);

    const { rows } = await world.owner.query(
      `SELECT status, valid_to FROM unit_membership WHERE id = $1`,
      [membership!.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('REVOKED');
  });

  it('returns 404 for a membership that does not exist', async () => {
    const response = await world.request(
      'DELETE',
      `${base}/units/${world.unitA}/memberships/00000000-0000-4000-8000-000000000000`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    expect(response.status).toBe(404);
  });
});
