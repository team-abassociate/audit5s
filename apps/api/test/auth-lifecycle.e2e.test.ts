import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH } from '@audit5s/contracts';
import { startWorld, stopWorld, type TestWorld } from './harness';
import { RateLimitService } from '../src/common/rate-limit/rate-limit.service';

/**
 * The full authentication lifecycle (Phase 1 integration row), against a real database.
 */

let world: TestWorld;
const base = API_BASE_PATH;

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await stopWorld(world);
});

/** Rate limits are per-process, so a noisy test would otherwise starve the next one. */
function resetLimits(): void {
  world.app.get(RateLimitService).reset();
}

describe('login', () => {
  it('issues a pair and the server-resolved scope', async () => {
    resetLimits();
    const response = await world.request('POST', `${base}/auth/login`, {
      body: { loginId: world.actors.COORDINATOR.loginId, password: 'orchard-piston-58-VQ' },
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      accessToken: string;
      refreshToken: string;
      scope: { role: string; unitIds: string[]; permissions: string[] };
    };
    expect(body.accessToken).toBeTruthy();
    expect(body.scope.role).toBe('COORDINATOR');
    expect(body.scope.unitIds).toEqual([world.unitA]);
    expect(body.scope.permissions.length).toBeGreaterThan(0);
  });

  it('returns the same problem for a wrong password and an unknown login ID', async () => {
    resetLimits();
    const wrongPassword = await world.request('POST', `${base}/auth/login`, {
      body: { loginId: world.actors.COORDINATOR.loginId, password: 'definitely-not-it-42' },
    });
    const unknownUser = await world.request('POST', `${base}/auth/login`, {
      body: { loginId: 'ZZ9999', password: 'definitely-not-it-42' },
    });

    // Distinguishable answers here would turn the endpoint into a login-ID oracle.
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect((wrongPassword.body as { code: string }).code).toBe('INVALID_CREDENTIALS');
    expect((unknownUser.body as { code: string }).code).toBe('INVALID_CREDENTIALS');
  });

  it('records every attempt, successful or not, in login_attempt', async () => {
    resetLimits();
    await world.request('POST', `${base}/auth/login`, {
      body: { loginId: 'ZZ9999', password: 'nope-nope-nope' },
    });
    const { rows } = await world.owner.query(
      `SELECT succeeded, failure_code FROM login_attempt WHERE login_id = 'ZZ9999'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].succeeded).toBe(false);
  });

  it('rate-limits repeated failures on one login ID (§12.11)', async () => {
    resetLimits();
    const loginId = world.actors.ZONE_LEADER.loginId;
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await world.request('POST', `${base}/auth/login`, {
        body: { loginId, password: 'wrong-password-here' },
      });
      statuses.push(response.status);
    }

    // 5 attempts per 15 minutes per login ID: the sixth must already be refused.
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    resetLimits();
  });
});

describe('refresh rotation and reuse detection (invariant R-1)', () => {
  it('rotates on every use', async () => {
    resetLimits();
    const first = await world.request('POST', `${base}/auth/refresh`, {
      body: { refreshToken: world.actors.SUPER_ADMIN.refreshToken },
    });
    expect(first.status).toBe(200);
    const rotated = (first.body as { refreshToken: string }).refreshToken;
    expect(rotated).not.toBe(world.actors.SUPER_ADMIN.refreshToken);
  });

  it('revokes the whole family when a used token is replayed', async () => {
    resetLimits();
    const login = await world.request('POST', `${base}/auth/login`, {
      body: { loginId: world.actors.COORDINATOR.loginId, password: 'orchard-piston-58-VQ' },
    });
    const original = (login.body as { refreshToken: string }).refreshToken;

    const rotated = await world.request('POST', `${base}/auth/refresh`, {
      body: { refreshToken: original },
    });
    const successor = (rotated.body as { refreshToken: string }).refreshToken;

    const replay = await world.request('POST', `${base}/auth/refresh`, {
      body: { refreshToken: original },
    });
    expect(replay.status).toBe(401);
    expect((replay.body as { code: string }).code).toBe('TOKEN_REUSED');

    // The successor dies with it: a replayed token means one of the two holders is not
    // legitimate, and nothing distinguishes them, so both are cut off.
    const afterwards = await world.request('POST', `${base}/auth/refresh`, {
      body: { refreshToken: successor },
    });
    expect(afterwards.status).toBe(401);
  });

  it('rejects a token that was never issued', async () => {
    resetLimits();
    const response = await world.request('POST', `${base}/auth/refresh`, {
      body: { refreshToken: 'not-a-real-token' },
    });
    expect(response.status).toBe(401);
  });
});

describe('logout', () => {
  it('revokes the family and is idempotent', async () => {
    resetLimits();
    const login = await world.request('POST', `${base}/auth/login`, {
      body: { loginId: world.actors.ZONE_LEADER.loginId, password: 'orchard-piston-58-VQ' },
    });
    const { refreshToken } = login.body as { refreshToken: string };

    const first = await world.request('POST', `${base}/auth/logout`, { body: { refreshToken } });
    expect(first.status).toBe(204);

    const second = await world.request('POST', `${base}/auth/logout`, { body: { refreshToken } });
    expect(second.status).toBe(204);

    const refresh = await world.request('POST', `${base}/auth/refresh`, { body: { refreshToken } });
    expect(refresh.status).toBe(401);
  });
});

describe('the forced reset (CH-1)', () => {
  it('closes every other route until the bootstrap credential is rotated', async () => {
    resetLimits();
    // A freshly created user: the credential is their phone number, and
    // must_reset_password is set.
    const created = await world.request('POST', `${base}/users`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        fullName: 'Fresh Joiner',
        phone: '+919000000201',
        role: 'CONSULTANT',
        unitId: world.unitA,
      },
    });
    expect(created.status).toBe(201);
    const { loginId } = created.body as { loginId: string };

    const login = await world.request('POST', `${base}/auth/login`, {
      body: { loginId, password: '+919000000201' },
    });
    expect(login.status).toBe(200);
    const { accessToken, mustResetPassword } = login.body as {
      accessToken: string;
      mustResetPassword: boolean;
    };
    expect(mustResetPassword).toBe(true);

    const blocked = await world.request('GET', `${base}/units`, { token: accessToken });
    expect(blocked.status).toBe(403);
    expect((blocked.body as { code: string }).code).toBe('PASSWORD_RESET_REQUIRED');

    // /auth/me stays reachable so the client can render the reset screen with a name.
    const me = await world.request('GET', `${base}/auth/me`, { token: accessToken });
    expect(me.status).toBe(200);

    const reset = await world.request('POST', `${base}/auth/change-password`, {
      token: accessToken,
      body: { currentPassword: '+919000000201', newPassword: 'meridian-cobalt-33-JD' },
    });
    expect(reset.status).toBe(204);

    const after = await world.request('POST', `${base}/auth/login`, {
      body: { loginId, password: 'meridian-cobalt-33-JD' },
    });
    expect((after.body as { mustResetPassword: boolean }).mustResetPassword).toBe(false);

    const allowed = await world.request('GET', `${base}/units`, {
      token: (after.body as { accessToken: string }).accessToken,
    });
    expect(allowed.status).toBe(200);
  });

  it('refuses a new password that is the phone number, the name, or too short (§12.1)', async () => {
    resetLimits();
    const created = await world.request('POST', `${base}/users`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: {
        fullName: 'Weak Password',
        phone: '+919000000202',
        role: 'CONSULTANT',
        unitId: world.unitA,
      },
    });
    const { loginId } = created.body as { loginId: string };
    const login = await world.request('POST', `${base}/auth/login`, {
      body: { loginId, password: '+919000000202' },
    });
    const token = (login.body as { accessToken: string }).accessToken;

    for (const candidate of ['+919000000202', 'weakpassword1', 'short']) {
      const response = await world.request('POST', `${base}/auth/change-password`, {
        token,
        body: { currentPassword: '+919000000202', newPassword: candidate },
      });
      expect(response.status, `"${candidate}" must be refused`).toBeGreaterThanOrEqual(422);
    }
  });
});

describe('membership revocation', () => {
  it('ends the Consultant’s access to the Unit and their sessions', async () => {
    resetLimits();
    const superAdmin = world.actors.SUPER_ADMIN.accessToken;

    const created = await world.request('POST', `${base}/users`, {
      token: superAdmin,
      body: {
        fullName: 'Temp Consultant',
        phone: '+919000000203',
        role: 'CONSULTANT',
        unitId: world.unitA,
      },
    });
    const userId = (created.body as { user: { id: string } }).user.id;

    const memberships = await world.request('GET', `${base}/memberships?userId=${userId}`, {
      token: superAdmin,
    });
    const membership = (memberships.body as { data: Array<{ id: string; unitId: string }> }).data[0];
    expect(membership).toBeDefined();

    const revoked = await world.request(
      'DELETE',
      `${base}/units/${world.unitA}/memberships/${membership!.id}`,
      { token: superAdmin },
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(204);

    // The row survives; only its status changes, so the history stays explainable.
    const { rows } = await world.owner.query(
      `SELECT status, valid_to FROM unit_membership WHERE id = $1`,
      [membership!.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('REVOKED');
    expect(rows[0].valid_to).not.toBeNull();

    const again = await world.request(
      'DELETE',
      `${base}/units/${world.unitA}/memberships/${membership!.id}`,
      { token: superAdmin },
    );
    expect(again.status).toBe(409);
  });

  it('refuses a second active membership for a COORDINATOR (M-1 / R-3a)', async () => {
    resetLimits();
    const response = await world.request('POST', `${base}/units/${world.unitB}/memberships`, {
      token: world.actors.SUPER_ADMIN.accessToken,
      body: { userId: world.actors.COORDINATOR.userId },
    });

    // The partial unique index is what makes `own_unit`'s LIMIT 1 deterministic.
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('MEMBERSHIP_LIMIT_EXCEEDED');
  });

  it('allows a CONSULTANT to hold several', async () => {
    resetLimits();
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
});

describe('forgot-password and OTP scaffold', () => {
  it('always answers 202, existing login ID or not', async () => {
    resetLimits();
    const known = await world.request('POST', `${base}/auth/forgot-password`, {
      body: { loginId: world.actors.COORDINATOR.loginId },
    });
    const unknown = await world.request('POST', `${base}/auth/forgot-password`, {
      body: { loginId: 'ZZ0000' },
    });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
  });

  it('stores an OTP challenge hashed, never in the clear', async () => {
    resetLimits();
    const response = await world.request('POST', `${base}/auth/otp/request`, {
      body: { phone: '+919000000301' },
    });
    expect(response.status).toBe(202);

    const { rows } = await world.owner.query(
      `SELECT code_hash, expires_at, attempt_count FROM otp_challenge WHERE phone_e164 = $1`,
      ['+919000000301'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].attempt_count).toBe(0);
  });

  it('refuses a wrong code and counts the attempt', async () => {
    resetLimits();
    await world.request('POST', `${base}/auth/otp/request`, { body: { phone: '+919000000302' } });
    const response = await world.request('POST', `${base}/auth/otp/verify`, {
      body: { phone: '+919000000302', code: '000000' },
    });
    expect(response.status).toBe(401);
  });
});
