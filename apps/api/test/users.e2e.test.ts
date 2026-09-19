import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH } from '@audit5s/contracts';
import { startWorld, stopWorld, type TestWorld } from './harness';

/**
 * The user routes the authorization sweep marks `coveredBy` — those needing a body it
 * cannot invent, or with side effects that would disturb the shared fixture.
 */

let world: TestWorld;
const base = API_BASE_PATH;

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await stopWorld(world);
});

describe('login-ID allocation (§12.2)', () => {
  it('creates a Consultant independently, without a Unit membership', async () => {
    const response = await world.request('POST', `${base}/users`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        fullName: 'Independent Consultant',
        phone: '+919000000400',
        role: 'CONSULTANT',
      },
    });
    expect(response.status).toBe(201);

    const userId = (response.body as { user: { id: string } }).user.id;
    const memberships = await world.request(
      'GET',
      `${base}/memberships?userId=${userId}&limit=200`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    expect((memberships.body as { data: unknown[] }).data).toEqual([]);
  });

  it('derives the ID from the name and the last four digits of the phone', async () => {
    const response = await world.request('POST', `${base}/users`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        fullName: 'Rahul Sharma',
        phone: '+919876543210',
        role: 'CONSULTANT',
        unitId: world.unitA,
      },
    });
    expect(response.status).toBe(201);
    expect((response.body as { loginId: string }).loginId).toBe('RA3210');
  });

  it('walks to the next candidate on a collision, inside the transaction', async () => {
    // Two different people whose name prefix and phone suffix coincide. This is the case
    // the retry loop exists for, and it is driven by the unique index rather than by a
    // read-then-write check, so there is no race to lose.
    const second = await world.request('POST', `${base}/users`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        fullName: 'Rajesh Rao',
        phone: '+919812343210',
        role: 'CONSULTANT',
        unitId: world.unitA,
      },
    });
    expect(second.status).toBe(201);
    expect((second.body as { loginId: string }).loginId).toBe('RA3210-2');

    const third = await world.request('POST', `${base}/users`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        fullName: 'Ravi Roy',
        phone: '+919700003210',
        role: 'CONSULTANT',
        unitId: world.unitA,
      },
    });
    expect((third.body as { loginId: string }).loginId).toBe('RA3210-3');
  });

  it('never returns a credential, only the login ID and the 72-hour expiry', async () => {
    const response = await world.request('POST', `${base}/users`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        fullName: 'Nina Prasad',
        phone: '+919000000401',
        role: 'ZONE_LEADER',
        unitId: world.unitA,
      },
    });

    const body = response.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['bootstrapExpiresAt', 'loginId', 'user']);
    expect(JSON.stringify(body)).not.toContain('argon2');
    expect(JSON.stringify(body)).not.toContain('passwordHash');

    const expiry = new Date(body.bootstrapExpiresAt as string).getTime() - Date.now();
    const hours = expiry / (60 * 60 * 1000);
    expect(hours).toBeGreaterThan(71);
    expect(hours).toBeLessThan(73);
  });
});

describe('a Coordinator creating users', () => {
  it('may create a Zone Leader, in their own Unit', async () => {
    const response = await world.request('POST', `${base}/users`, {
      token: world.actors.COORDINATOR.accessToken,
      body: { fullName: 'Leader Two', phone: '+919000000402', role: 'ZONE_LEADER' },
    });
    expect(response.status).toBe(201);

    const memberships = await world.request(
      `GET`,
      `${base}/memberships?userId=${(response.body as { user: { id: string } }).user.id}`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    const rows = (memberships.body as { data: Array<{ unitId: string }> }).data;
    // The Unit comes from the Coordinator's own membership, never from the body (AZ-2).
    expect(rows[0]?.unitId).toBe(world.unitA);
  });

  it('may not create a Consultant', async () => {
    const response = await world.request('POST', `${base}/users`, {
      token: world.actors.COORDINATOR.accessToken,
      body: { fullName: 'Sneaky Consultant', phone: '+919000000403', role: 'CONSULTANT' },
    });
    expect(response.status).toBe(403);
  });

  it('may not create a user in another Unit by putting its id in the body', async () => {
    const response = await world.request('POST', `${base}/users`, {
      token: world.actors.COORDINATOR.accessToken,
      body: {
        fullName: 'Elsewhere Leader',
        phone: '+919000000404',
        role: 'ZONE_LEADER',
        unitId: world.unitB,
      },
    });
    expect(response.status).toBe(201);

    const memberships = await world.request(
      'GET',
      `${base}/memberships?userId=${(response.body as { user: { id: string } }).user.id}`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    const rows = (memberships.body as { data: Array<{ unitId: string }> }).data;
    // The supplied unitId is ignored, not honoured: a body value is a filter, never a grant.
    expect(rows[0]?.unitId).toBe(world.unitA);
  });
});

describe('field-level allow-lists on update', () => {
  it('lets a Zone Leader change their own profile fields', async () => {
    const response = await world.request('PATCH', `${base}/users/${world.actors.ZONE_LEADER.userId}`, {
      token: world.actors.ZONE_LEADER.accessToken,
      body: { fullName: 'Zoe Leader-Smith' },
    });
    expect(response.status).toBe(200);
  });

  it('refuses a Zone Leader changing their own phone, which is an admin field', async () => {
    const response = await world.request('PATCH', `${base}/users/${world.actors.ZONE_LEADER.userId}`, {
      token: world.actors.ZONE_LEADER.accessToken,
      body: { phone: '+919000000499' },
    });
    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe('FIELD_NOT_EDITABLE');
  });

  it('refuses a Consultant editing somebody else', async () => {
    const response = await world.request('PATCH', `${base}/users/${world.inScopeUserId}`, {
      token: world.actors.CONSULTANT.accessToken,
      body: { fullName: 'Not Mine' },
    });
    expect(response.status).toBe(403);
  });
});

describe('disable and password reset', () => {
  it('disables a user and ends their access', async () => {
    const created = await world.request('POST', `${base}/users`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        fullName: 'Doomed Leader',
        phone: '9000000405',
        role: 'ZONE_LEADER',
        unitId: world.unitA,
      },
    });
    expect(created.status).toBe(201);
    expect((created.body as { user: { phoneE164: string } }).user.phoneE164).toBe('9000000405');
    const userId = (created.body as { user: { id: string } }).user.id;
    const deviceId = randomUUID();
    const session = await world.request('POST', `${base}/auth/login`, {
      body: {
        loginId: (created.body as { loginId: string }).loginId,
        password: '9000000405',
        deviceId,
        platform: 'android',
      },
    });
    expect(session.status).toBe(200);

    const disabled = await world.request('POST', `${base}/users/${userId}/disable`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    expect(disabled.status).toBe(204);

    const login = await world.request('POST', `${base}/auth/login`, {
      body: { loginId: (created.body as { loginId: string }).loginId, password: '9000000405' },
    });
    expect(login.status).toBe(401);
    expect((login.body as { code: string }).code).toBe('ACCOUNT_DISABLED');

    const activeSession = await world.request('GET', `${base}/auth/me`, {
      token: (session.body as { accessToken: string }).accessToken,
    });
    expect(activeSession.status).toBe(401);

    const refresh = await world.request('POST', `${base}/auth/refresh`, {
      body: { refreshToken: (session.body as { refreshToken: string }).refreshToken },
    });
    expect(refresh.status).toBe(401);

    const devices = await world.request(
      'GET',
      `${base}/devices?userId=${userId}&includeRevoked=true`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    expect(
      (devices.body as { data: Array<{ id: string; revokedAt: string | null }> }).data.find(
        (device) => device.id === deviceId,
      )?.revokedAt,
    ).not.toBeNull();
  });

  it('refuses to let an actor disable themselves', async () => {
    const response = await world.request(
      'POST',
      `${base}/users/${world.actors.SUPER_ADMIN.userId}/disable`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    expect(response.status).toBe(409);
  });

  it('reissues a bootstrap credential without returning it', async () => {
    const response = await world.request(
      'POST',
      `${base}/users/${world.inScopeUserId}/reset-password`,
      { token: world.actors.SUPER_ADMIN.accessToken },
    );
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['bootstrapExpiresAt', 'loginId']);
  });
});

describe('every administrative action reaches the audit log', () => {
  it('records user.created with a snapshotted actor label and a redacted diff', async () => {
    const logs = await world.request(`GET`, `${base}/audit-logs?action=user.created&limit=5`, {
      token: world.actors.SUPER_ADMIN.accessToken,
    });
    const entries = (logs.body as { data: Array<Record<string, unknown>> }).data;
    expect(entries.length).toBeGreaterThan(0);

    const entry = entries[0]!;
    expect(entry.actorLabel).toMatch(/\(.+\)$/);
    expect(entry.requestId).toBeTruthy();
    expect(JSON.stringify(entry.after)).not.toContain('argon2');
  });
});
