import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
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

/**
 * U1 (UX audit 2026-10-03): editing a Zone's description must not touch its leader.
 * `PATCH /zones/:id` is a patch — an omitted field is left alone — and a leader is either an
 * account (`zone_leader_id`) or the name an auditor typed (`zone_leader_name`, 0015).
 */
describe('a description-only edit keeps the leader (U1)', () => {
  let typedZoneId: string;
  let accountZoneId: string;

  beforeAll(async () => {
    const typed = await createZone(asCoordinator(), world.unitA, { code: 'Z-55', name: 'Paint' });
    typedZoneId = (typed.body as Zone).id;
    // The typed name only ever arrives from an audit (`app_set_zone_leader_name`); set it
    // directly here, as the owner, rather than conducting a whole audit to get one.
    await world.owner.query(`UPDATE zone SET zone_leader_name = 'Typed Leader' WHERE id = $1`, [
      typedZoneId,
    ]);

    const account = await createZone(asCoordinator(), world.unitA, {
      code: 'Z-56',
      name: 'Stores',
      zoneLeaderId: world.actors.ZONE_LEADER.userId,
    });
    accountZoneId = (account.body as Zone).id;
  });

  async function leaderColumns(zoneId: string) {
    const result = await world.owner.query<{
      zone_leader_id: string | null;
      zone_leader_name: string | null;
    }>(`SELECT zone_leader_id, zone_leader_name FROM zone WHERE id = $1`, [zoneId]);
    return result.rows[0];
  }

  it('keeps a typed leader when only the description changes', async () => {
    const response = await world.request('PATCH', `${base}/zones/${typedZoneId}`, {
      token: asCoordinator(),
      body: { description: 'Paint line' },
    });
    expect(response.status).toBe(200);
    const zone = response.body as Zone;
    expect(zone.description).toBe('Paint line');
    expect(zone.zoneLeaderId).toBeNull();
    expect(zone.zoneLeaderName).toBe('Typed Leader');
    expect(await leaderColumns(typedZoneId)).toEqual({
      zone_leader_id: null,
      zone_leader_name: 'Typed Leader',
    });
  });

  it('keeps an account leader when only the description changes', async () => {
    const response = await world.request('PATCH', `${base}/zones/${accountZoneId}`, {
      token: asCoordinator(),
      body: { description: 'Spares and consumables' },
    });
    expect(response.status).toBe(200);
    const zone = response.body as Zone;
    expect(zone.zoneLeaderId).toBe(world.actors.ZONE_LEADER.userId);
    expect(zone.zoneLeaderName).toBe('Zoe Leader');
  });

  it('still clears the account with an explicit null', async () => {
    const response = await world.request('PATCH', `${base}/zones/${accountZoneId}`, {
      token: asCoordinator(),
      body: { zoneLeaderId: null },
    });
    expect(response.status).toBe(200);
    expect((response.body as Zone).zoneLeaderId).toBeNull();
    expect((await leaderColumns(accountZoneId))?.zone_leader_id).toBeNull();
  });

  it('leaves a typed name alone when the account pointer is nulled', async () => {
    // The update contract has no field for the typed name, so `zoneLeaderId: null` clears
    // the account only. Released field-app builds send it on every Zone edit; making it
    // erase the typed name would wipe the leader on each of those saves.
    const response = await world.request('PATCH', `${base}/zones/${typedZoneId}`, {
      token: asCoordinator(),
      body: { zoneLeaderId: null },
    });
    expect(response.status).toBe(200);
    expect((response.body as Zone).zoneLeaderName).toBe('Typed Leader');
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

describe('editing a Zone (field report 2026-10-13)', () => {
  it('a leader chosen on the form replaces the one an auditor typed — Nobody included', async () => {
    const created = (await createZone(asCoordinator(), world.unitA, { code: 'Z-1A', name: 'Zone 1A' })).body as Zone;
    await world.owner.query(`UPDATE zone SET zone_leader_name = 'Shailendra Bahubali' WHERE id = $1`, [created.id]);

    const response = await world.request('PATCH', `${base}/zones/${created.id}`, {
      token: asCoordinator(),
      body: { code: 'Z-4A', name: 'Zone 1A', zoneLeaderId: null, zoneLeaderName: null },
    });
    expect(response.status).toBe(200);
    const zone = response.body as Zone;
    expect(zone.zoneLeaderName).toBeNull();
    // Still called by its number, the name follows the renumbering.
    expect(zone.code).toBe('Z-4A');
    expect(zone.name).toBe('Zone 4A');
  });

  it('keeps a typed leader and a chosen name when neither is changed', async () => {
    const created = (await createZone(asCoordinator(), world.unitA, { code: 'Z-2B', name: 'Paint shop' })).body as Zone;
    await world.owner.query(`UPDATE zone SET zone_leader_name = 'Ravi Kumar' WHERE id = $1`, [created.id]);

    const response = await world.request('PATCH', `${base}/zones/${created.id}`, {
      token: asCoordinator(),
      body: { code: 'Z-3B', description: 'Booth 2' },
    });
    const zone = response.body as Zone;
    expect(zone.zoneLeaderName).toBe('Ravi Kumar');
    expect(zone.name).toBe('Paint shop');
  });
});

describe('R-59 — importing a Unit’s Zone list', () => {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  /** The template's shape: a title row, the three headings, then one Zone a row. */
  async function workbook(rows: string[][]): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Table 1');
    sheet.addRow(['Name Of Your Unit']);
    sheet.addRow(['Zone No.', 'Zone Discription(Name)', 'Leader', ...(rows.some((row) => row.length > 3) ? ['Mobile No.'] : [])]);
    for (const row of rows) sheet.addRow(row);
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  async function importList(token: string, unitId: string, body: Buffer) {
    return world.upload(
      `${base}/units/${unitId}/zones/import`,
      { filename: 'zones.xlsx', contentType: XLSX, body },
      { token },
    );
  }

  async function activeZones(unitId: string): Promise<Zone[]> {
    const response = await world.request('GET', `${base}/units/${unitId}/zones?limit=200`, {
      token: asSuperAdmin(),
    });
    return (response.body as Page<Zone>).data;
  }

  it('replaces the Unit’s list: adds, updates, archives, and marks the Unit imported', async () => {
    const first = await importList(
      asCoordinator(),
      world.unitA,
      await workbook([
        ['Zone 01', 'Maintenance Room', 'Mr. A. Sharma'],
        ['Zone 02', 'Boiler Room', 'Ms. B. Rao'],
        ['Zone 03', '', ''],
      ]),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // The fixture's Unit may already have a Zone 01; either way the file's two are there.
    const { created, updated } = first.body as { created: number; updated: number };
    expect(created + updated).toBe(2);

    const zones = await activeZones(world.unitA);
    expect(zones.map((zone) => zone.code).sort()).toEqual(['Z-01', 'Z-02']);
    expect(zones.find((zone) => zone.code === 'Z-02')).toMatchObject({
      name: 'Boiler Room',
      zoneLeaderName: 'Ms. B. Rao',
    });
    const unit = await world.request('GET', `${base}/units/${world.unitA}`, { token: asCoordinator() });
    expect((unit.body as { zoneListImportedAt: string | null }).zoneListImportedAt).not.toBeNull();

    const second = await importList(
      asSuperAdmin(),
      world.unitA,
      await workbook([
        ['1', 'Maintenance Room & Press Pit', 'Mr. A. Sharma'],
        ['Zone 04', 'Canteen', ''],
      ]),
    );
    expect(second.body).toMatchObject({ created: 1, updated: 1, archived: 1 });
    expect((await activeZones(world.unitA)).map((zone) => zone.name).sort()).toEqual([
      'Canteen',
      'Maintenance Room & Press Pit',
    ]);
  });

  it('clears the description of a Zone the file names (R-67)', async () => {
    // The list the test before left, so nothing is archived for the tests after.
    const rows = [
      ['Zone 01', 'Maintenance Room & Press Pit', 'Mr. A. Sharma'],
      ['Zone 04', 'Canteen', ''],
    ];
    const canteen = (await activeZones(world.unitA)).find((zone) => zone.code === 'Z-04')!;
    await world.request('PATCH', `${base}/zones/${canteen.id}`, {
      token: asCoordinator(),
      body: { description: 'Typed by an earlier auditor' },
    });

    const response = await importList(asCoordinator(), world.unitA, await workbook(rows));
    expect(response.body).toMatchObject({ updated: 1 });
    expect((await activeZones(world.unitA)).find((zone) => zone.code === 'Z-04')?.description).toBeNull();
  });

  it('restores an archived Zone the next file names again', async () => {
    const response = await importList(
      asCoordinator(),
      world.unitA,
      await workbook([
        ['Zone 01', 'Maintenance Room & Press Pit', 'Mr. A. Sharma'],
        ['Zone 02', 'Boiler Room', ''],
        ['Zone 04', 'Canteen', ''],
      ]),
    );
    expect(response.body).toMatchObject({ created: 0, updated: 1, archived: 0 });
    const restored = (await activeZones(world.unitA)).find((zone) => zone.code === 'Z-02');
    expect(restored?.archivedAt).toBeNull();
  });

  it('a file naming a different leader replaces the Zone’s account leader', async () => {
    const zone = (await activeZones(world.unitA)).find((z) => z.code === 'Z-01')!;
    const assigned = await world.request('POST', `${base}/zones/${zone.id}/leader`, {
      token: asCoordinator(),
      body: { zoneLeaderId: world.actors.ZONE_LEADER.userId },
    });
    expect((assigned.body as Zone).zoneLeaderName).toBe('Zoe Leader');

    const response = await importList(
      asCoordinator(),
      world.unitA,
      await workbook([
        ['Zone 01', 'Maintenance Room & Press Pit', 'Mr. D. Mehta'],
        ['Zone 02', 'Boiler Room', ''],
        ['Zone 04', 'Canteen', ''],
      ]),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await activeZones(world.unitA)).find((z) => z.code === 'Z-01')).toMatchObject({
      zoneLeaderId: null,
      zoneLeaderName: 'Mr. D. Mehta',
    });
  });

  it('refuses a file without the three headings, and changes nothing', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Sheet1').addRow(['Area', 'Owner']);
    const response = await importList(asCoordinator(), world.unitA, Buffer.from(await book.xlsx.writeBuffer()));
    expect(response.status).toBe(422);
    expect(await activeZones(world.unitA)).toHaveLength(3);
  });

  it('is not a Coordinator’s for another Unit, nor a Consultant’s', async () => {
    const body = await workbook([['Zone 01', 'Trespass', '']]);
    expect((await importList(asCoordinator(), world.unitB, body)).status).toBe(404);
    expect((await importList(world.actors.CONSULTANT.accessToken, world.unitA, body)).status).toBe(403);
  });

  it('R-64: keeps a Zone’s several leaders as its names, makes no subzone and no account', async () => {
    const before = await world.request('GET', `${base}/users?role=ZONE_LEADER&limit=200`, { token: asCoordinator() });
    const response = await importList(
      asCoordinator(),
      world.unitA,
      await workbook([
        ['Zone 01', 'Press', 'Mr. Ajay Singh Ms. Neha Rao', '7000000102\n7000000103'],
        ['Zone 02', 'Boiler', 'Mr. Ravi Kumar', '7000000101'],
      ]),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as { notes: string[] }).notes).toEqual([
      expect.stringMatching(/^Mobile numbers are not read from the Zone list/),
    ]);
    const zones = await activeZones(world.unitA);
    expect(zones.find((zone) => zone.code === 'Z-01')?.zoneLeaderName).toBe('Mr. Ajay Singh, Ms. Neha Rao');
    expect(zones.some((zone) => zone.code === 'Z-1A')).toBe(false);
    const after = await world.request('GET', `${base}/users?role=ZONE_LEADER&limit=200`, { token: asCoordinator() });
    expect((after.body as Page<never>).data).toHaveLength((before.body as Page<never>).data.length);
  });
});

describe('R-64 — the Auditor list makes the Unit’s Zone Leader and auditor accounts', () => {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  type Result = { created: number; existing: number; notes: string[] };
  type Person = { id: string; fullName: string; phoneE164: string; role: string; mustResetPassword: boolean };

  async function auditorList(rows: Array<Array<string | number>>): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Auditors');
    sheet.addRow(['Name Of Your Unit']);
    sheet.addRow(['Zone No.', 'ZL', 'Name', 'Mobile No.']);
    for (const row of rows) sheet.addRow(row);
    return Buffer.from(await book.xlsx.writeBuffer());
  }
  async function importAuditors(token: string, unitId: string, body: Buffer) {
    return world.upload(
      `${base}/units/${unitId}/auditors/import`,
      { filename: 'auditors.xlsx', contentType: XLSX, body },
      { token },
    );
  }
  async function people(): Promise<Person[]> {
    const response = await world.request('GET', `${base}/users?limit=200`, { token: asCoordinator() });
    return (response.body as Page<Person>).data;
  }

  it('makes an account, with no Zone, for each person the Unit has none for', async () => {
    const response = await importAuditors(
      asCoordinator(),
      world.unitA,
      await auditorList([
        ['Zone 01', 'ZL1', 'Mr. Om Prakash', '7000000201'],
        ['Zone 01', 'ZL2', 'Ms. Lata Joshi', '+91 70000 00202'],
        ['Zone 01', 'ZL3', '', ''],
        // Already the Unit's Zone Leader, by name.
        ['Zone 02', 'ZL1', 'zoe  leader', '7000000299'],
        ['', 'Auditor', 'Dr. Senior Visitor', '7000000203'],
        ['Zone 03', 'ZL1', 'Mr. No Number', ''],
      ]),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({
      created: 4,
      existing: 1,
      awaitingNumber: 1,
      notes: [expect.stringMatching(/^1 account was made without a mobile number and cannot sign in yet/)],
    });
    const om = (await people()).find((user) => user.fullName === 'Mr. Om Prakash')!;
    expect(om).toMatchObject({ role: 'ZONE_LEADER', phoneE164: '7000000201', mustResetPassword: true });
    // An account is not tied to a Zone: the Zone's leaders stay the names the Zone list gave.
    const zones = await world.request('GET', `${base}/units/${world.unitA}/zones?limit=200`, { token: asSuperAdmin() });
    expect((zones.body as Page<Zone>).data.some((zone) => zone.zoneLeaderId === om.id)).toBe(false);
  });

  it('R-65: a name without a number waits for it; adding it makes the login, which signs in', async () => {
    const waiting = (await people()).find((user) => user.fullName === 'Mr. No Number')!;
    expect(waiting).toMatchObject({ loginId: null, phoneE164: null, role: 'ZONE_LEADER' });
    const reset = await world.request('POST', `${base}/users/${waiting.id}/reset-password`, { token: asCoordinator() });
    expect(reset.status).toBe(409);

    const added = await world.request('PATCH', `${base}/users/${waiting.id}`, {
      token: asCoordinator(),
      body: { phone: '7000000210' },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const login = added.body as Person & { loginId: string };
    expect(login).toMatchObject({ loginId: 'MR0210', phoneE164: '7000000210', mustResetPassword: true });

    const signIn = await world.request('POST', `${base}/auth/login`, {
      body: { loginId: 'MR0210', password: '7000000210', deviceId: randomUUID(), platform: 'android' },
    });
    // The number is the first password: it signs in, and must be changed (CH-1).
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
  });

  it('again makes nobody twice, and names a number another Unit’s account holds', async () => {
    const elsewhere = await world.request('POST', `${base}/users`, {
      token: asSuperAdmin(),
      body: { fullName: 'Bina Other', phone: '7000000205', role: 'ZONE_LEADER', unitId: world.unitB },
    });
    expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(201);
    const response = await importAuditors(
      asCoordinator(),
      world.unitA,
      await auditorList([
        ['Zone 01', 'ZL1', 'Mr. Om Prakash', '7000000201'],
        ['Zone 04', 'ZL1', 'Mr. Tarun Mehta', '7000000205'],
      ]),
    );
    expect(response.status).toBe(200);
    const result = response.body as Result;
    expect(result).toMatchObject({ created: 0, existing: 1 });
    expect(result.notes[0]).toMatch(/^No account for Mr\. Tarun Mehta\. This phone number already belongs/);
  });

  it('is not a Coordinator’s for another Unit, nor a Consultant’s', async () => {
    const body = await auditorList([['', 'Auditor', 'Mr. Trespass', '7000000206']]);
    expect((await importAuditors(asCoordinator(), world.unitB, body)).status).toBe(404);
    expect((await importAuditors(world.actors.CONSULTANT.accessToken, world.unitA, body)).status).toBe(403);
  });

  it('lets a Coordinator add a Zone Leader with no Zone by hand', async () => {
    const response = await world.request('POST', `${base}/users`, {
      token: asCoordinator(),
      body: { fullName: 'Ad Hoc Auditor', phone: '7000000207', role: 'ZONE_LEADER' },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it('shows a Coordinator their Zone Leaders and themselves — no Consultant, no other Coordinator', async () => {
    const roles = new Set((await people()).map((user) => user.role));
    expect([...roles].sort()).toEqual(['COORDINATOR', 'ZONE_LEADER']);
    const consultants = await world.request('GET', `${base}/users?role=CONSULTANT&limit=200`, { token: asCoordinator() });
    expect((consultants.body as Page<never>).data).toEqual([]);
    const consultant = await world.request('GET', `${base}/users/${world.actors.CONSULTANT.userId}`, {
      token: asCoordinator(),
    });
    expect(consultant.status).toBe(404);
    const memberships = await world.request('GET', `${base}/memberships?unitId=${world.unitA}&status=ACTIVE&limit=200`, {
      token: asCoordinator(),
    });
    const listed = (memberships.body as Page<{ role: string; userId: string }>).data;
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((m) => m.role === 'ZONE_LEADER' || m.userId === world.actors.COORDINATOR.userId)).toBe(true);
  });

  it('gives a Unit one Coordinator', async () => {
    const second = await world.request('POST', `${base}/users`, {
      token: asSuperAdmin(),
      body: { fullName: 'Second Coord', phone: '7000000208', role: 'COORDINATOR', unitId: world.unitA },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(422);
    const other = await world.request('POST', `${base}/users`, {
      token: asSuperAdmin(),
      body: { fullName: 'Unit B Coord', phone: '7000000209', role: 'COORDINATOR', unitId: world.unitB },
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
  });
});
