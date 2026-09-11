import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH } from '@audit5s/contracts';
import { startWorld, stopWorld, type TestWorld } from './harness';

/**
 * The Phase 1 acceptance row (ARCHITECTURE.md PART 14), walked literally as one narrative:
 *
 *   "Super Admin creates a Unit, a Consultant and a Coordinator; the Consultant logs in on
 *    a device, is forced to reset, and sees exactly their assigned Units; a Coordinator's
 *    attempt to rename their Unit returns 403 FIELD_NOT_EDITABLE; a Coordinator reading
 *    another Unit's data returns 404; every administrative action appears in the audit log."
 *
 * The individual rules have their own focused tests. This exists because the acceptance
 * criterion is a *sequence* — the Consultant's bootstrap credential is the phone number
 * the Super Admin typed two steps earlier, and the audit log has to hold all of it at the
 * end. Assertions scattered across files cannot show that the steps connect.
 */
describe('Phase 1 acceptance', () => {
  let world: TestWorld;
  const url = (path: string) => `${API_BASE_PATH}${path}`;

  beforeAll(async () => {
    world = await startWorld();
  });

  afterAll(async () => {
    await stopWorld(world);
  });

  it('runs end to end', async () => {
    // `startWorld` truncates and builds its fixtures with direct SQL, so the audit log is
    // empty here and the assertion at the end sees only what this narrative produced.
    const admin = world.actors.SUPER_ADMIN.accessToken;

    // --- 1. Super Admin creates a Unit ---------------------------------------
    const unit = await world.request('POST', url('/units'), {
      token: admin,
      body: { code: 'PLANT-1', name: 'Nashik Plant 1', city: 'Nashik', state: 'Maharashtra' },
    });
    expect(unit.status).toBe(201);
    const unitId = (unit.body as { id: string }).id;

    // --- 2. …and a Consultant, assigned to it --------------------------------
    const consultantPhone = '+919812345678';
    const consultant = await world.request('POST', url('/users'), {
      token: admin,
      body: {
        fullName: 'Rahul Sharma',
        phone: consultantPhone,
        role: 'CONSULTANT',
        unitId,
      },
    });
    expect(consultant.status).toBe(201);
    const consultantBody = consultant.body as {
      loginId: string;
      bootstrapExpiresAt: string;
      user: { id: string };
    };

    // The login ID is derived, not chosen: "Rahul Sharma" + the last four digits (§12.2).
    expect(consultantBody.loginId).toBe('RA5678');
    // No password and no hash is ever returned (§12.1); the body is the shape §8.4
    // specifies — { user, loginId, bootstrapExpiresAt }.
    const created = JSON.stringify(consultant.body);
    expect(created).not.toMatch(/\$argon2id\$/);
    expect(created).not.toMatch(/"(password|passwordHash|password_hash)"/);
    expect(new Date(consultantBody.bootstrapExpiresAt).getTime()).toBeGreaterThan(Date.now());

    // Note: `user.phoneE164` *is* in this body, because §8.4 specifies `user` and §5.2
    // puts the phone on it. Until the forced reset happens, that field is also the
    // bootstrap credential — so anyone who may read a user's profile may sign in as them
    // inside the 72-hour window. That follows from CH-1 rather than from this endpoint,
    // and it is raised as a residual risk rather than papered over by quietly dropping a
    // field the admin UI and the specified contract both expect.

    // --- 3. …and a Coordinator -----------------------------------------------
    const coordinator = await world.request('POST', url('/users'), {
      token: admin,
      body: {
        fullName: 'Priya Nair',
        phone: '+919823456789',
        role: 'COORDINATOR',
        unitId,
      },
    });
    expect(coordinator.status).toBe(201);
    const coordinatorLoginId = (coordinator.body as { loginId: string }).loginId;

    // --- 4. The Consultant logs in on a device -------------------------------
    const deviceId = '11111111-2222-4333-8444-555555555555';
    const firstLogin = await world.request('POST', url('/auth/login'), {
      body: {
        loginId: consultantBody.loginId,
        // CH-1: the bootstrap credential is the phone number the Super Admin typed above.
        password: consultantPhone,
        deviceId,
        platform: 'android',
        model: 'Pixel 7a',
      },
    });
    expect(firstLogin.status).toBe(200);
    const session = firstLogin.body as { accessToken: string; mustResetPassword: boolean };
    expect(session.mustResetPassword).toBe(true);

    // The device registered itself as part of signing in.
    const devices = await world.owner.query('SELECT id, model FROM device WHERE id = $1', [deviceId]);
    expect(devices.rows).toHaveLength(1);
    expect(devices.rows[0].model).toBe('Pixel 7a');

    // --- 5. …and is forced to reset before anything else works ---------------
    const blocked = await world.request('GET', url('/units'), { token: session.accessToken });
    expect(blocked.status).toBe(403);
    expect((blocked.body as { code: string }).code).toBe('PASSWORD_RESET_REQUIRED');

    const reset = await world.request('POST', url('/auth/change-password'), {
      token: session.accessToken,
      body: { currentPassword: consultantPhone, newPassword: 'harbour-lantern-27-QF' },
    });
    expect(reset.status).toBe(204);

    // --- 6. …then sees exactly their assigned Units --------------------------
    const secondLogin = await world.request('POST', url('/auth/login'), {
      body: { loginId: consultantBody.loginId, password: 'harbour-lantern-27-QF', deviceId },
    });
    expect(secondLogin.status).toBe(200);
    const consultantToken = (secondLogin.body as { accessToken: string }).accessToken;

    const visible = await world.request('GET', url('/units'), { token: consultantToken });
    expect(visible.status).toBe(200);
    const codes = (visible.body as { data: Array<{ code: string }> }).data.map((u) => u.code);
    // Exactly their assigned Unit: not Unit A, not Unit B, not every Unit in the org.
    expect(codes).toEqual(['PLANT-1']);

    // --- 7. A Coordinator renaming their Unit → 403 FIELD_NOT_EDITABLE -------
    const coordinatorLogin = await world.request('POST', url('/auth/login'), {
      body: { loginId: coordinatorLoginId, password: '+919823456789' },
    });
    const coordinatorReset = await world.request('POST', url('/auth/change-password'), {
      token: (coordinatorLogin.body as { accessToken: string }).accessToken,
      body: { currentPassword: '+919823456789', newPassword: 'meadow-cinder-44-TB' },
    });
    expect(coordinatorReset.status).toBe(204);

    const coordinatorSignedIn = await world.request('POST', url('/auth/login'), {
      body: { loginId: coordinatorLoginId, password: 'meadow-cinder-44-TB' },
    });
    const coordinatorToken = (coordinatorSignedIn.body as { accessToken: string }).accessToken;

    const rename = await world.request('PATCH', url(`/units/${unitId}`), {
      token: coordinatorToken,
      body: { name: 'Renamed By Coordinator' },
    });
    expect(rename.status).toBe(403);
    expect((rename.body as { code: string }).code).toBe('FIELD_NOT_EDITABLE');
    expect((rename.body as { errors: Array<{ field: string }> }).errors.map((e) => e.field)).toContain(
      'name',
    );

    // --- 8. A Coordinator reading another Unit's data → 404 ------------------
    // Not 403: a 403 would confirm the Unit exists, which is exactly the probe AZ-3 closes.
    const otherUnit = await world.request('GET', url(`/units/${world.unitB}`), {
      token: coordinatorToken,
    });
    expect(otherUnit.status).toBe(404);

    // --- 9. Every administrative action appears in the audit log -------------
    const log = await world.owner.query(
      `SELECT action, actor_label, resource_id, after FROM audit_log ORDER BY id`,
    );
    const actions = log.rows.map((r: { action: string }) => r.action);

    expect(actions).toContain('unit.created');
    expect(actions).toContain('user.created');
    expect(actions).toContain('user.password_reset');

    // The actor is snapshotted as a label, so a later rename does not obscure history.
    const unitCreated = log.rows.find((r: { action: string }) => r.action === 'unit.created');
    expect(unitCreated.actor_label).toMatch(/\(.+\)$/);
    expect(unitCreated.resource_id).toBe(unitId);

    // Nothing in the log is a credential (§12.12).
    const serialised = JSON.stringify(log.rows);
    expect(serialised).not.toContain(consultantPhone);
    expect(serialised).not.toContain('harbour-lantern-27-QF');
    expect(serialised).not.toMatch(/\$argon2id\$/);
  });
});
