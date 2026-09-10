import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Connection strings for the schema tests. These run against a real PostgreSQL — the
 * constraints under test *are* database constraints, so a mock would assert nothing.
 */
export const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgres://audit5s_owner:audit5s_owner@127.0.0.1:5432/audit5s';

export const APP_URL =
  process.env.DATABASE_URL ?? 'postgres://audit5s_app:audit5s_app@127.0.0.1:5432/audit5s';

export async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Applies every pending migration. Safe to call repeatedly. */
export function migrate(): void {
  execFileSync('npx', ['tsx', join(__dirname, 'migrate.ts')], {
    env: { ...process.env, DATABASE_MIGRATION_URL: OWNER_URL },
    stdio: 'pipe',
  });
}

/**
 * Clears business rows between tests.
 *
 * TRUNCATE, not DELETE: the append-only triggers exist precisely to refuse a row DELETE,
 * and TRUNCATE does not fire row-level triggers. That is safe here and not a hole in
 * AL-1, because TRUNCATE is an owner-only privilege — the application role has no grant
 * for it, which `schema.test.ts` asserts directly.
 */
export async function resetFixtures(owner: Client): Promise<void> {
  await owner.query(`
    TRUNCATE audit_log, login_attempt, idempotency_key, revoked_access_token,
             refresh_token, otp_challenge, device, unit_membership, unit, "user"
    RESTART IDENTITY CASCADE;
  `);
}

export const IDS = {
  superAdmin: '11111111-1111-1111-1111-111111111111',
  coordinatorA: '22222222-2222-2222-2222-222222222222',
  consultant: '33333333-3333-3333-3333-333333333333',
  zoneLeaderA: '44444444-4444-4444-4444-444444444444',
  unitA: 'aaaaaaaa-0000-0000-0000-000000000001',
  unitB: 'aaaaaaaa-0000-0000-0000-000000000002',
} as const;

/** Two Units, one user per role, the Consultant assigned to both Units. */
export async function seedFixtures(owner: Client): Promise<void> {
  await owner.query(
    `INSERT INTO "user" (id, login_id, full_name, phone_e164, role, password_hash, status)
     VALUES ($1,'SA0001','Super Admin','+919000000001','SUPER_ADMIN','x','ACTIVE'),
            ($2,'CO0002','Coord One','+919000000002','COORDINATOR','x','ACTIVE'),
            ($3,'CN0003','Consult One','+919000000003','CONSULTANT','x','ACTIVE'),
            ($4,'ZL0004','Leader One','+919000000004','ZONE_LEADER','x','ACTIVE')`,
    [IDS.superAdmin, IDS.coordinatorA, IDS.consultant, IDS.zoneLeaderA],
  );
  await owner.query(
    `INSERT INTO unit (id, code, name) VALUES ($1,'U-A','Unit A'), ($2,'U-B','Unit B')`,
    [IDS.unitA, IDS.unitB],
  );
  await owner.query(
    `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
     VALUES ($1,$5,'COORDINATOR',$4),
            ($2,$5,'ZONE_LEADER',$4),
            ($3,$5,'CONSULTANT',$4),
            ($3,$6,'CONSULTANT',$4)`,
    [IDS.coordinatorA, IDS.zoneLeaderA, IDS.consultant, IDS.superAdmin, IDS.unitA, IDS.unitB],
  );
}

/** Runs `work` inside a transaction carrying the given actor context. */
export async function asActor<T>(
  client: Client,
  actorId: string | null,
  actorRole: string | null,
  work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    if (actorId) {
      await client.query(`SELECT set_config('app.actor_id', $1, true)`, [actorId]);
    }
    if (actorRole) {
      await client.query(`SELECT set_config('app.actor_role', $1, true)`, [actorRole]);
    }
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
