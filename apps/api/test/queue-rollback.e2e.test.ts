import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, createPool } from '@audit5s/db';
import type { Pool } from 'pg';
import { QUEUES, QueueService } from '../src/infrastructure/queue/queue.service';
import { APP_URL, startWorld, stopWorld, type TestWorld } from './harness';

/**
 * DECISIONS.md R-2, the permanent verification.
 *
 * pg-boss is the only enqueue mechanism, and the `domain_event` outbox was removed on the
 * strength of one guarantee: a job enqueued inside a domain transaction does not become
 * visible to workers if that transaction rolls back.
 *
 *     BEGIN → enqueue job → ROLLBACK → assert no worker ever receives the job
 *
 * If this ever fails against the pinned pg-boss version, that is a finding to raise — not
 * a reason to quietly reintroduce a second mechanism.
 */

let world: TestWorld;
let queue: QueueService;
let pool: Pool;

beforeAll(async () => {
  world = await startWorld();
  queue = world.app.get(QueueService);
  pool = createPool({ connectionString: APP_URL, max: 2 });
});

afterAll(async () => {
  await pool?.end();
  await stopWorld(world);
});

async function pendingJobCount(queueName: string): Promise<number> {
  const db = createDatabase(pool);
  const result = await db.execute(
    sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${queueName}`,
  );
  const rows = (result as unknown as { rows: Array<{ n: number }> }).rows;
  return rows[0]?.n ?? 0;
}

describe('transactional enqueue (R-2)', () => {
  it('does not publish a job when the surrounding transaction rolls back', async () => {
    const db = createDatabase(pool);
    const before = await pendingJobCount(QUEUES.maintenanceSweep);

    const marker = `rollback-${Date.now()}`;

    await expect(
      db.transaction(async (tx) => {
        await queue.sendInTransaction(tx, QUEUES.maintenanceSweep, { marker });
        // The domain write fails after the enqueue, exactly as it would in production.
        throw new Error('domain write failed');
      }),
    ).rejects.toThrow('domain write failed');

    const after = await pendingJobCount(QUEUES.maintenanceSweep);
    expect(after, 'a rolled-back transaction must leave no job behind').toBe(before);

    const result = await db.execute(
      sql`SELECT count(*)::int AS n FROM pgboss.job
          WHERE name = ${QUEUES.maintenanceSweep} AND data->>'marker' = ${marker}`,
    );
    const rows = (result as unknown as { rows: Array<{ n: number }> }).rows;
    expect(rows[0]?.n).toBe(0);
  });

  it('does publish the job when the transaction commits', async () => {
    const db = createDatabase(pool);
    const marker = `commit-${Date.now()}`;

    await db.transaction(async (tx) => {
      await queue.sendInTransaction(tx, QUEUES.maintenanceSweep, { marker });
    });

    const result = await db.execute(
      sql`SELECT count(*)::int AS n FROM pgboss.job
          WHERE name = ${QUEUES.maintenanceSweep} AND data->>'marker' = ${marker}`,
    );
    const rows = (result as unknown as { rows: Array<{ n: number }> }).rows;
    // Without this half, the test above would pass just as well if enqueueing never worked.
    expect(rows[0]?.n).toBe(1);
  });
});
