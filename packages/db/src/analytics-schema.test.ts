import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { APP_URL, IDS, OWNER_URL, asActor, connect, migrate, resetFixtures, seedFixtures } from './test-support';

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

describe('Phase 8 analytics schema', () => {
  it('makes a Unit/day rollup an idempotent unique key', async () => {
    await owner.query(`INSERT INTO metric_daily_unit (unit_id, day) VALUES ($1, '2026-02-01')`, [IDS.unitA]);
    await expect(
      owner.query(`INSERT INTO metric_daily_unit (unit_id, day) VALUES ($1, '2026-02-01')`, [IDS.unitA]),
    ).rejects.toThrow(/metric_daily_unit_key/);
  });

  it('never permits a derived row to be deleted', async () => {
    await owner.query(`INSERT INTO metric_daily_unit (unit_id, day) VALUES ($1, '2026-02-01')`, [IDS.unitA]);
    await expect(owner.query(`DELETE FROM metric_daily_unit WHERE unit_id = $1`, [IDS.unitA])).rejects.toThrow(/never deleted/i);
  });

  it('keeps Coordinator reads inside their Unit', async () => {
    await owner.query(
      `INSERT INTO metric_daily_unit (unit_id, day, completed_count)
       VALUES ($1, '2026-02-01', 1), ($2, '2026-02-01', 9)`,
      [IDS.unitA, IDS.unitB],
    );
    const rows = await asActor(app, IDS.coordinatorA, 'COORDINATOR', async () =>
      app.query(`SELECT unit_id FROM metric_daily_unit ORDER BY unit_id`),
    );
    expect(rows.rows.map((row) => row.unit_id)).toEqual([IDS.unitA]);
  });

  it('ships the BRIN index on the append-only audit log', async () => {
    const { rows } = await owner.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_log_occurred_brin'`,
    );
    expect(rows[0]?.indexdef).toMatch(/USING brin \(occurred_at\)/i);
  });
});
