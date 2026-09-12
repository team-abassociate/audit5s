import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { APP_URL, IDS, OWNER_URL, asActor, connect, migrate, resetFixtures, seedFixtures } from './test-support';

/**
 * Schema invariants, asserted against a real PostgreSQL.
 *
 * These are database guarantees (STACK.md §5), so they are tested as database guarantees:
 * a mock would only assert that the test author remembered the rule.
 */

let owner: Client;
let app: Client;

beforeAll(async () => {
  migrate();
  owner = await connect(OWNER_URL);
  app = await connect(APP_URL);
});

afterAll(async () => {
  await owner?.end();
  await app?.end();
});

beforeEach(async () => {
  await resetFixtures(owner);
  await seedFixtures(owner);
});

describe('invariant M-1 — one active administrative membership (R-3a)', () => {
  it('refuses a second ACTIVE membership for a COORDINATOR', async () => {
    // Every `own_unit` predicate depends on this, because the resolver uses LIMIT 1.
    await expect(
      owner.query(
        `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
         VALUES ($1, $2, 'COORDINATOR', $3)`,
        [IDS.coordinatorA, IDS.unitB, IDS.superAdmin],
      ),
    ).rejects.toThrow(/unit_membership_one_active_admin/);
  });

  it('refuses a second ACTIVE membership for a ZONE_LEADER', async () => {
    await expect(
      owner.query(
        `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
         VALUES ($1, $2, 'ZONE_LEADER', $3)`,
        [IDS.zoneLeaderA, IDS.unitB, IDS.superAdmin],
      ),
    ).rejects.toThrow(/unit_membership_one_active_admin/);
  });

  it('permits a CONSULTANT to hold many ACTIVE memberships', async () => {
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM unit_membership
       WHERE user_id = $1 AND status = 'ACTIVE'`,
      [IDS.consultant],
    );
    expect(rows[0].n).toBe(2);
  });

  it('frees the slot once the previous membership is revoked, not deleted', async () => {
    await owner.query(
      `UPDATE unit_membership SET status = 'REVOKED', valid_to = now()
       WHERE user_id = $1 AND status = 'ACTIVE'`,
      [IDS.coordinatorA],
    );
    await expect(
      owner.query(
        `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
         VALUES ($1, $2, 'COORDINATOR', $3)`,
        [IDS.coordinatorA, IDS.unitB, IDS.superAdmin],
      ),
    ).resolves.toBeDefined();

    // The revoked row survives, so the history stays explainable.
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM unit_membership WHERE user_id = $1`,
      [IDS.coordinatorA],
    );
    expect(rows[0].n).toBe(2);
  });

  it('keeps the denormalised role honest even when the caller supplies a wrong one', async () => {
    // A membership whose role disagrees with the user's would corrupt every predicate
    // built on it, so the database overrides the claim rather than trusting the caller.
    const { rows: created } = await owner.query(
      `INSERT INTO "user" (login_id, full_name, phone_e164, role, password_hash, status)
       VALUES ('CN0007','Consult Two','+919000000007','CONSULTANT','x','ACTIVE')
       RETURNING id`,
    );
    const userId = created[0].id;

    await owner.query(
      `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
       VALUES ($1, $2, 'SUPER_ADMIN', $3)`,
      [userId, IDS.unitA, IDS.superAdmin],
    );

    const { rows } = await owner.query(
      `SELECT role FROM unit_membership WHERE user_id = $1`,
      [userId],
    );
    expect(rows.map((r: { role: string }) => r.role)).toEqual(['CONSULTANT']);
  });
});

describe('invariant AL-1 — audit_log is append-only', () => {
  beforeEach(async () => {
    await owner.query(
      `INSERT INTO audit_log (actor_label, action, resource_type, request_id)
       VALUES ('system', 'unit.created', 'unit', 'req-1')`,
    );
  });

  it('raises on UPDATE, even for the owner', async () => {
    await expect(owner.query(`UPDATE audit_log SET action = 'tampered'`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('raises on DELETE, even for the owner', async () => {
    await expect(owner.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });

  it('denies the application role UPDATE and DELETE at the privilege level', async () => {
    // Two independent lines: the grant is absent *and* the trigger raises.
    await expect(
      asActor(app, IDS.superAdmin, 'SUPER_ADMIN', () =>
        app.query(`UPDATE audit_log SET action = 'tampered'`),
      ),
    ).rejects.toThrow(/permission denied/);

    await expect(
      asActor(app, IDS.superAdmin, 'SUPER_ADMIN', () => app.query('DELETE FROM audit_log')),
    ).rejects.toThrow(/permission denied/);
  });

  it('denies the application role TRUNCATE, which would bypass the row trigger', async () => {
    // TRUNCATE does not fire row-level triggers, so the guarantee rests on the privilege.
    await expect(
      asActor(app, IDS.superAdmin, 'SUPER_ADMIN', () => app.query('TRUNCATE audit_log')),
    ).rejects.toThrow(/permission denied/);
  });

  it('still accepts inserts from the application role', async () => {
    await expect(
      asActor(app, IDS.superAdmin, 'SUPER_ADMIN', () =>
        app.query(
          `INSERT INTO audit_log (actor_user_id, actor_role, actor_label, action, resource_type, request_id)
           VALUES ($1, 'SUPER_ADMIN', 'Super Admin (SA0001)', 'unit.created', 'unit', 'req-2')`,
          [IDS.superAdmin],
        ),
      ),
    ).resolves.toBeDefined();
  });
});

describe('login_attempt is append-only', () => {
  it('records failures immutably', async () => {
    await owner.query(
      `INSERT INTO login_attempt (login_id, succeeded, failure_code)
       VALUES ('RA3210', false, 'INVALID_CREDENTIALS')`,
    );
    await expect(owner.query(`UPDATE login_attempt SET succeeded = true`)).rejects.toThrow(
      /append-only/,
    );
    await expect(owner.query('DELETE FROM login_attempt')).rejects.toThrow(/append-only/);
  });
});

describe('append-only carve-out mechanism (DECISIONS.md R-5)', () => {
  /**
   * `evidence` arrives in Phase 5. What must exist now is the mechanism, so that the
   * trigger is never created without its carve-out and then altered over live audit data.
   * This exercises the parameterised trigger function on a stand-in shaped like `evidence`.
   */
  beforeEach(async () => {
    await owner.query('DROP TABLE IF EXISTS evidence_carveout_probe');
    await owner.query(`
      CREATE TABLE evidence_carveout_probe (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        caption text,
        checksum_sha256 text,
        redacted_at timestamptz,
        redacted_by_user_id uuid,
        redaction_reason text
      );
      CREATE TRIGGER probe_append_only BEFORE UPDATE OR DELETE ON evidence_carveout_probe
        FOR EACH ROW EXECUTE FUNCTION
          enforce_append_only('redacted_at','redacted_by_user_id','redaction_reason');
    `);
    await owner.query(
      `INSERT INTO evidence_carveout_probe (caption, checksum_sha256) VALUES ('a photo','abc123')`,
    );
  });

  it('permits an update touching only the three redaction columns', async () => {
    await expect(
      owner.query(
        `UPDATE evidence_carveout_probe SET redacted_at = now(), redaction_reason = 'erasure request'`,
      ),
    ).resolves.toBeDefined();
  });

  it('keeps the row and its checksum after redaction — erasure is redaction, not deletion', async () => {
    await owner.query(`UPDATE evidence_carveout_probe SET redacted_at = now()`);
    const { rows } = await owner.query('SELECT checksum_sha256 FROM evidence_carveout_probe');
    expect(rows).toHaveLength(1);
    expect(rows[0].checksum_sha256).toBe('abc123');
  });

  it('refuses an update to any column outside the carve-out', async () => {
    await expect(
      owner.query(`UPDATE evidence_carveout_probe SET caption = 'tampered'`),
    ).rejects.toThrow(/column caption may not be updated/);
  });

  it('refuses DELETE regardless of the carve-out', async () => {
    await expect(owner.query('DELETE FROM evidence_carveout_probe')).rejects.toThrow(
      /DELETE is not permitted/,
    );
  });
});

describe('row-level security', () => {
  it('returns nothing when no actor context is set — the fail-closed default', async () => {
    // A repository that forgets the context sees no rows, not every row.
    const units = await app.query('SELECT * FROM unit');
    const users = await app.query('SELECT * FROM "user"');
    const memberships = await app.query('SELECT * FROM unit_membership');
    expect(units.rows).toHaveLength(0);
    expect(users.rows).toHaveLength(0);
    expect(memberships.rows).toHaveLength(0);
  });

  it('shows a COORDINATOR only their own Unit', async () => {
    const names = await asActor(app, IDS.coordinatorA, 'COORDINATOR', async () => {
      const { rows } = await app.query('SELECT name FROM unit ORDER BY name');
      return rows.map((r: { name: string }) => r.name);
    });
    expect(names).toEqual(['Unit A']);
  });

  it('shows a ZONE_LEADER only their own Unit', async () => {
    const names = await asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', async () => {
      const { rows } = await app.query('SELECT name FROM unit ORDER BY name');
      return rows.map((r: { name: string }) => r.name);
    });
    expect(names).toEqual(['Unit A']);
  });

  it('shows a CONSULTANT every assigned Unit', async () => {
    const names = await asActor(app, IDS.consultant, 'CONSULTANT', async () => {
      const { rows } = await app.query('SELECT name FROM unit ORDER BY name');
      return rows.map((r: { name: string }) => r.name);
    });
    expect(names).toEqual(['Unit A', 'Unit B']);
  });

  it('shows a SUPER_ADMIN the whole organization', async () => {
    const names = await asActor(app, IDS.superAdmin, 'SUPER_ADMIN', async () => {
      const { rows } = await app.query('SELECT name FROM unit ORDER BY name');
      return rows.map((r: { name: string }) => r.name);
    });
    expect(names).toEqual(['Unit A', 'Unit B']);
  });

  it('hides a revoked Consultant’s Unit the moment the membership is revoked', async () => {
    await owner.query(
      `UPDATE unit_membership SET status = 'REVOKED', valid_to = now()
       WHERE user_id = $1 AND unit_id = $2`,
      [IDS.consultant, IDS.unitB],
    );
    const names = await asActor(app, IDS.consultant, 'CONSULTANT', async () => {
      const { rows } = await app.query('SELECT name FROM unit ORDER BY name');
      return rows.map((r: { name: string }) => r.name);
    });
    // Immediately, not at token expiry — which is why scope is never carried in the JWT.
    expect(names).toEqual(['Unit A']);
  });

  it('restricts the audit log to a SUPER_ADMIN', async () => {
    await owner.query(
      `INSERT INTO audit_log (actor_label, action, resource_type, request_id)
       VALUES ('system','unit.created','unit','req-1')`,
    );

    const asCoordinator = await asActor(app, IDS.coordinatorA, 'COORDINATOR', async () => {
      const { rows } = await app.query('SELECT * FROM audit_log');
      return rows;
    });
    expect(asCoordinator).toHaveLength(0);

    const asSuperAdmin = await asActor(app, IDS.superAdmin, 'SUPER_ADMIN', async () => {
      const { rows } = await app.query('SELECT * FROM audit_log');
      return rows;
    });
    expect(asSuperAdmin).toHaveLength(1);
  });

  it('does not let one user read another user’s stored idempotent response', async () => {
    await asActor(app, IDS.consultant, 'CONSULTANT', () =>
      app.query(
        `INSERT INTO idempotency_key (key, user_id, endpoint, request_hash, expires_at)
         VALUES ('k-1', $1, '/reports/generate', 'h', now() + interval '48 hours')`,
        [IDS.consultant],
      ),
    );

    const otherUsersView = await asActor(app, IDS.coordinatorA, 'COORDINATOR', async () => {
      const { rows } = await app.query(`SELECT * FROM idempotency_key WHERE key = 'k-1'`);
      return rows;
    });
    expect(otherUsersView).toHaveLength(0);
  });
});

describe('uniqueness rules', () => {
  it('reserves a login ID forever, including for archived users (§12.2)', async () => {
    await owner.query(`UPDATE "user" SET archived_at = now() WHERE id = $1`, [IDS.consultant]);
    await expect(
      owner.query(
        `INSERT INTO "user" (login_id, full_name, phone_e164, role, password_hash)
         VALUES ('CN0003','New Joiner','+919000000009','CONSULTANT','x')`,
      ),
    ).rejects.toThrow(/user_login_id_key/);
  });

  it('frees a phone number once a user is archived', async () => {
    await owner.query(`UPDATE "user" SET archived_at = now() WHERE id = $1`, [IDS.consultant]);
    await expect(
      owner.query(
        `INSERT INTO "user" (login_id, full_name, phone_e164, role, password_hash)
         VALUES ('NJ0003','New Joiner','+919000000003','CONSULTANT','x')`,
      ),
    ).resolves.toBeDefined();
  });

  it('enforces a unique Unit name — the Unit has no other identifier', async () => {
    await expect(owner.query(`INSERT INTO unit (name) VALUES ('Unit A')`)).rejects.toThrow(
      /unit_name_key/,
    );
  });

  it('treats email uniqueness case-insensitively', async () => {
    await owner.query(`UPDATE "user" SET email = 'Person@Example.com' WHERE id = $1`, [
      IDS.consultant,
    ]);
    await expect(
      owner.query(
        `INSERT INTO "user" (login_id, full_name, phone_e164, email, role, password_hash)
         VALUES ('XX0009','Other','+919000000099','person@example.com','CONSULTANT','x')`,
      ),
    ).rejects.toThrow(/user_email_active_key/);
  });
});
