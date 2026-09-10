import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH, type Page, type Zone } from '@audit5s/contracts';
import { zoneCodeForNumber } from '@audit5s/domain';
import { startWorld, stopWorld, type TestWorld } from './harness';

/**
 * Zone routes the authorization sweep marks `coveredBy`, plus the Phase 2 behaviours
 * PART 14 names: code uniqueness per Unit, the archive guard, and a Coordinator who
 * cannot reach another Unit.
 */

let world: TestWorld;
const base = API_BASE_PATH;

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await stopWorld(world);
});

const asCoordinator = () => world.actors.COORDINATOR.accessToken;
const asSuperAdmin = () => world.actors.SUPER_ADMIN.accessToken;

async function createZone(token: string, unitId: string, body: Record<string, unknown>) {
  return world.request('POST', `${base}/units/${unitId}/zones`, { token, body });
}

describe('a Coordinator managing their own Unit’s Zones', () => {
  it('creates a Zone with a code from the 1–100 helper', async () => {
    const response = await createZone(asCoordinator(), world.unitA, {
      code: zoneCodeForNumber(7),
      name: 'Grinding',
      description: 'Trimming section',
      sortOrder: 7,
    });
    expect(response.status).toBe(201);
    const zone = response.body as Zone;
    expect(zone.code).toBe('Z-07');
    expect(zone.unitId).toBe(world.unitA);
    expect(zone.zoneLeaderId).toBeNull();
  });

  it('refuses a duplicate code inside the Unit', async () => {
    const response = await createZone(asCoordinator(), world.unitA, {
      code: 'Z-07',
      name: 'Another grinding',
    });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('DUPLICATE_CODE');
  });

  it('allows the same code in a different Unit — uniqueness is per Unit', async () => {
    const response = await createZone(asSuperAdmin(), world.unitB, {
      code: 'Z-07',
      name: 'Grinding at B',
    });
    expect(response.status).toBe(201);
  });

  it('cannot create a Zone in another Unit: 404, never a hint that it exists', async () => {
    const response = await createZone(asCoordinator(), world.unitB, {
      code: 'Z-99',
      name: 'Trespass',
    });
    expect(response.status).toBe(404);
    expect((response.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('creates 20 Zones and 5 Zone Leaders in its own Unit (the acceptance row)', async () => {
    for (let zoneNumber = 10; zoneNumber < 30; zoneNumber += 1) {
      const response = await createZone(asCoordinator(), world.unitA, {
        code: zoneCodeForNumber(zoneNumber),
        name: `Zone ${zoneNumber}`,
        sortOrder: zoneNumber,
      });
      expect(response.status, `zone ${zoneNumber}: ${JSON.stringify(response.body)}`).toBe(201);
    }

    const listed = await world.request('GET', `${base}/units/${world.unitA}/zones?limit=200`, {
      token: asCoordinator(),
    });
    expect((listed.body as Page<Zone>).data.length).toBeGreaterThanOrEqual(20);

    // …and five Zone Leaders, which a Coordinator may create for their own Unit alone.
    for (let leader = 1; leader <= 5; leader += 1) {
      const created = await world.request('POST', `${base}/users`, {
        token: asCoordinator(),
        body: {
          fullName: `Leader ${leader}`,
          phone: `+9198765432${String(leader).padStart(2, '0')}`,
          role: 'ZONE_LEADER',
          unitId: world.unitA,
        },
      });
      expect(created.status, `leader ${leader}: ${JSON.stringify(created.body)}`).toBe(201);
    }
  });

  it('cannot place a Zone Leader in another Unit — the body’s unitId is not a grant (AZ-2)', async () => {
    const response = await world.request('POST', `${base}/users`, {
      token: asCoordinator(),
      body: {
        fullName: 'Leader Elsewhere',
        phone: '+919876543299',
        role: 'ZONE_LEADER',
        // A Coordinator naming Unit B. Scope is derived from their membership, so this
        // is a filter the server ignores rather than an instruction it obeys.
        unitId: world.unitB,
      },
    });
    expect(response.status).toBe(201);

    const { loginId } = response.body as { loginId: string };
    const { rows } = await world.owner.query(
      `SELECT m.unit_id FROM unit_membership m
       JOIN "user" u ON u.id = m.user_id
       WHERE u.login_id = $1 AND m.status = 'ACTIVE'`,
      [loginId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].unit_id).toBe(world.unitA);
  });

  it('cannot create a Consultant at all — only Zone Leaders', async () => {
    const response = await world.request('POST', `${base}/users`, {
      token: asCoordinator(),
      body: {
        fullName: 'Sneaky Consultant',
        phone: '+919876543298',
        role: 'CONSULTANT',
        unitId: world.unitA,
      },
    });
    expect(response.status).toBe(403);
  });
});

describe('the Zone Leader pointer (C2 — a responsibility, not a permission)', () => {
  let zoneId: string;

  beforeAll(async () => {
    const created = await createZone(asCoordinator(), world.unitA, {
      code: 'Z-40',
      name: 'Boiler house',
    });
    zoneId = (created.body as Zone).id;
  });

  it('points a Zone at a Zone Leader of the same Unit', async () => {
    const response = await world.request('POST', `${base}/zones/${zoneId}/leader`, {
      token: asCoordinator(),
      body: { zoneLeaderId: world.actors.ZONE_LEADER.userId },
    });
    expect(response.status).toBe(200);
    const zone = response.body as Zone;
    expect(zone.zoneLeaderId).toBe(world.actors.ZONE_LEADER.userId);
    expect(zone.zoneLeaderName).toBe('Zoe Leader');
  });

  it('refuses a leader who is not an active member of the Unit', async () => {
    const response = await world.request('POST', `${base}/zones/${zoneId}/leader`, {
      token: asCoordinator(),
      body: { zoneLeaderId: world.outOfScopeUserId },
    });
    expect(response.status).toBe(422);
    expect((response.body as { errors?: Array<{ field: string }> }).errors?.[0]?.field).toBe(
      'zoneLeaderId',
    );
  });

  it('clears the pointer with an explicit null', async () => {
    const response = await world.request('POST', `${base}/zones/${zoneId}/leader`, {
      token: asCoordinator(),
      body: { zoneLeaderId: null },
    });
    expect(response.status).toBe(200);
    expect((response.body as Zone).zoneLeaderId).toBeNull();
  });

  it('does not grant the leader anything: they still cannot edit the Zone', async () => {
    await world.request('POST', `${base}/zones/${zoneId}/leader`, {
      token: asCoordinator(),
      body: { zoneLeaderId: world.actors.ZONE_LEADER.userId },
    });

    const response = await world.request('PATCH', `${base}/zones/${zoneId}`, {
      token: world.actors.ZONE_LEADER.accessToken,
      body: { description: 'I lead this Zone' },
    });
    expect(response.status).toBe(403);
  });
});

describe('editing a Zone', () => {
  let zoneId: string;

  beforeAll(async () => {
    const created = await createZone(asCoordinator(), world.unitA, { code: 'Z-50', name: 'Yard' });
    zoneId = (created.body as Zone).id;
  });

  it('lets a Coordinator change the description freely (D6)', async () => {
    const response = await world.request('PATCH', `${base}/zones/${zoneId}`, {
      token: asCoordinator(),
      body: { description: 'Open yard behind the packing shed' },
    });
    expect(response.status).toBe(200);
    expect((response.body as Zone).description).toBe('Open yard behind the packing shed');
  });

  it('clears a description when the field is emptied', async () => {
    const response = await world.request('PATCH', `${base}/zones/${zoneId}`, {
      token: asCoordinator(),
      body: { description: '' },
    });
    expect(response.status).toBe(200);
    expect((response.body as Zone).description).toBeNull();
  });

  it('refuses a stale optimistic version', async () => {
    const response = await world.request('PATCH', `${base}/zones/${zoneId}`, {
      token: asCoordinator(),
      body: { name: 'Yard 2', version: 1 },
    });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('VERSION_CONFLICT');
  });

  it('refuses to move a Zone between Units — the field does not exist (Z-1)', async () => {
    const response = await world.request('PATCH', `${base}/zones/${zoneId}`, {
      token: asSuperAdmin(),
      body: { unitId: world.unitB },
    });
    // No recognised field to change, so the request never reaches the row.
    expect(response.status).toBe(422);

    const unchanged = await world.request('GET', `${base}/zones/${zoneId}`, {
      token: asSuperAdmin(),
    });
    expect((unchanged.body as Zone).unitId).toBe(world.unitA);
  });

  it('returns 404 for another Unit’s Zone rather than 403 (AZ-3)', async () => {
    const response = await world.request('PATCH', `${base}/zones/${world.zoneB}`, {
      token: asCoordinator(),
      body: { description: 'Not mine' },
    });
    expect(response.status).toBe(404);
  });
});

describe('archiving', () => {
  let zoneId: string;

  beforeAll(async () => {
    const created = await createZone(asCoordinator(), world.unitA, {
      code: 'Z-60',
      name: 'Old store',
    });
    zoneId = (created.body as Zone).id;
  });

  it('removes the Zone from the dropdown but leaves it addressable', async () => {
    const archived = await world.request('POST', `${base}/zones/${zoneId}/archive`, {
      token: asCoordinator(),
    });
    expect(archived.status).toBe(204);

    const active = await world.request('GET', `${base}/units/${world.unitA}/zones?limit=200`, {
      token: asCoordinator(),
    });
    expect((active.body as Page<Zone>).data.some((zone) => zone.id === zoneId)).toBe(false);

    const all = await world.request(
      'GET',
      `${base}/units/${world.unitA}/zones?active=false&limit=200`,
      { token: asCoordinator() },
    );
    expect((all.body as Page<Zone>).data.some((zone) => zone.id === zoneId)).toBe(true);
  });

  it('returns 409 ZONE_HAS_IN_PROGRESS_AUDIT while an audit is running', async () => {
    const busy = await createZone(asCoordinator(), world.unitA, {
      code: 'Z-61',
      name: 'Mid-audit zone',
    });
    const busyId = (busy.body as Zone).id;

    // Phase 3 gave `zone_has_in_progress_audit` a real body, so the condition is created
    // the way the field creates it: an IN_PROGRESS audit holding an unfinished Zone.
    const auditId = '01930000-0000-7000-8000-0000000000a1';
    await world.owner.query(
      `INSERT INTO audit (id, unit_id, audit_type, status, auditor_user_id)
       VALUES ($1, $2, 'EXTERNAL_5S', 'IN_PROGRESS', $3)`,
      [auditId, world.unitA, world.actors.CONSULTANT.userId],
    );
    await world.owner.query(
      `INSERT INTO audit_zone (id, audit_id, zone_id, sequence_no, status,
                               zone_code_snapshot, zone_name_snapshot)
       VALUES (gen_random_uuid(), $1, $2, 1, 'IN_PROGRESS', 'Z-61', 'Mid-audit zone')`,
      [auditId, busyId],
    );

    const response = await world.request('POST', `${base}/zones/${busyId}/archive`, {
      token: asCoordinator(),
    });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('ZONE_HAS_IN_PROGRESS_AUDIT');

    // Finishing the Zone frees it. Nothing is deleted to get there (A-1).
    await world.owner.query(
      `UPDATE audit_zone SET status = 'COMPLETED', completed_at = now() WHERE audit_id = $1`,
      [auditId],
    );
    const afterwards = await world.request('POST', `${base}/zones/${busyId}/archive`, {
      token: asCoordinator(),
    });
    expect(afterwards.status).toBe(204);
  });
});

describe('scope', () => {
  it('shows a Consultant the Zones of their assigned Units and no others', async () => {
    const response = await world.request('GET', `${base}/zones?limit=200`, {
      token: world.actors.CONSULTANT.accessToken,
    });
    expect(response.status).toBe(200);
    const zones = (response.body as Page<Zone>).data;
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.every((zone) => zone.unitId === world.unitA)).toBe(true);
  });

  it('shows a Super Admin every Unit’s Zones', async () => {
    const response = await world.request('GET', `${base}/zones?limit=200`, {
      token: asSuperAdmin(),
    });
    const unitIds = new Set((response.body as Page<Zone>).data.map((zone) => zone.unitId));
    expect(unitIds).toContain(world.unitA);
    expect(unitIds).toContain(world.unitB);
  });
});
