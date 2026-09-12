import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, createPool } from '@audit5s/db';
import type { Pool } from 'pg';
import type { HealthCheck } from '@audit5s/contracts';
import { QUEUES, QueueService, deadLetterOf } from '../src/infrastructure/queue/queue.service';
import { APP_URL, startWorld, stopWorld, type TestWorld } from './harness';

/**
 * Phase 9: a job that cannot be processed must leave something behind for a human.
 *
 * Before this, a job that exhausted its retries stopped at pg-boss's `failed` state with no
 * dead-letter queue configured, and was deleted with the rest of the queue's history — so
 * the payload that failed was gone by the time anyone asked what had happened. Two of the
 * workers already had comments promising a dead-letter that did not exist.
 *
 * §16.12 makes dead-lettered jobs a warning-level alert, and `/health` is the only surface
 * BetterStack polls, so the two halves are asserted together.
 */

let world: TestWorld;
let queue: QueueService;
let pool: Pool;

const DEAD_LETTER = deadLetterOf(QUEUES.maintenanceSweep);
const MARKER = `dlq-${Date.now()}`;

beforeAll(async () => {
  world = await startWorld();
  queue = world.app.get(QueueService);
  pool = createPool({ connectionString: APP_URL, max: 2 });

  // An earlier suite may have left one behind; the "healthy" assertion below is only
  // meaningful from a clean starting point.
  await createDatabase(pool).execute(sql`DELETE FROM pgboss.job WHERE name LIKE '%.dlq'`);
});

afterAll(async () => {
  // The deliberate failure above is this suite's own litter; leaving it would degrade the
  // health check for every file that runs after it.
  await createDatabase(pool).execute(sql`DELETE FROM pgboss.job WHERE name LIKE '%.dlq'`);
  await pool?.end();
  await stopWorld(world);
});

async function deadLetteredCount(marker: string): Promise<number> {
  const result = await createDatabase(pool).execute(
    sql`SELECT count(*)::int AS n FROM pgboss.job
        WHERE name = ${DEAD_LETTER} AND data->>'marker' = ${marker}`,
  );
  return (result as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0;
}

async function health(): Promise<{ status: number; body: HealthCheck }> {
  const response = await world.request('GET', '/api/v1/health');
  return { status: response.status, body: response.body as HealthCheck };
}

describe('dead-letter queues (§16.12)', () => {
  it('reports the queue healthy while nothing has been dead-lettered', async () => {
    const { status, body } = await health();

    expect(status).toBe(200);
    expect(body.checks.queue?.status).toBe('ok');
    expect(body.status).toBe('ok');
  });

  it('copies a job that exhausts its retries onto its dead-letter queue', async () => {
    // Marker-gated so a stray job from another suite is completed rather than failed, and
    // `retryLimit: 0` so the assertion does not wait out the queue's real retry backoff.
    await queue.work<{ marker?: string }>(QUEUES.maintenanceSweep, async (jobs) => {
      if (jobs.some((job) => job.data.marker === MARKER)) {
        throw new Error('deliberate failure: this job cannot be processed');
      }
    });

    await queue.send(QUEUES.maintenanceSweep, { marker: MARKER }, { retryLimit: 0 });

    const deadline = Date.now() + 30_000;
    let count = 0;
    while (Date.now() < deadline && count === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      count = await deadLetteredCount(MARKER);
    }

    expect(count, 'the failed payload must survive on the dead-letter queue').toBe(1);
  });

  it('degrades the health check and names the queue, without failing it', async () => {
    const { status, body } = await health();

    // 200 and `degraded`, not 503: the API is answering correctly, and paging on lost
    // background work would train the on-call to ignore the page (§16.12's warning band).
    expect(status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks.queue?.status).toBe('degraded');
    expect(body.checks.queue?.detail).toContain(DEAD_LETTER);
    // The database is untouched by any of this.
    expect(body.checks.database?.status).toBe('ok');
  });
});
