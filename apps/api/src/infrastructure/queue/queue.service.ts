import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle } from 'pg-boss';
import type * as PgBossTypes from 'pg-boss';
import type { Database, Transaction } from '@audit5s/db';
import { DATABASE } from '../database/database.module';
import { CONFIG, type AppConfig } from '../../config/env';

/** Queue names. One place, so a typo is a compile error rather than a job that never runs. */
export const QUEUES = {
  checklistImport: 'checklist.import',
  reportRender: 'report.render',
  notificationSend: 'notification.send',
  maintenanceSweep: 'maintenance.sweep',
  /** §9.5 Layer 1: releases the device lock on a PAUSED audit past its grace period. */
  deviceRelease: 'device.release',
  /**
   * §5.4's `EVIDENCE_ATTACHED` consumer: "media worker (thumbnail, EXIF strip)".
   *
   * Enqueued inside `commit`'s own transaction (R-2), so a job never exists for a
   * photograph whose commit rolled back.
   */
  mediaProcess: 'media.process',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Every queue has a dead-letter companion, `<queue>.dlq`.
 *
 * Without one, a job that exhausts its retries stops at pg-boss's `failed` state and is
 * deleted with the rest of the queue's history — so the payload that could not be
 * processed is gone by the time anyone asks what happened. With one, pg-boss copies the
 * payload across, where it stays until a human redrives or discards it. §16.12 makes
 * "dead-letter items appearing" a warning-level alert, and `/health` is where it is read
 * (`queueHealth()` below); STACK.md §5 asks for it by name for the report worker.
 *
 * A dead-letter queue has no dead-letter queue of its own: nothing works it, so nothing
 * can fail on it.
 */
export const DEAD_LETTER_SUFFIX = '.dlq';

export function deadLetterOf(queue: QueueName): string {
  return `${queue}${DEAD_LETTER_SUFFIX}`;
}

/**
 * Retries, in one place rather than at each call site.
 *
 * These are **queue-level** defaults, which is what makes them a policy: pg-boss inherits
 * them into every job unless the `send` overrides them, so a job enqueued by code that
 * passed no options is still retried and still dead-lettered. Before this they were
 * per-`send` and only two call sites set any, which left the media pipeline and the
 * nightly rollup on pg-boss's bare defaults (two immediate retries, no dead letter).
 */
const RETRY_POLICY = { retryLimit: 3, retryDelay: 30, retryBackoff: true } as const;

/**
 * STACK.md §5 pins the report worker: "120s job timeout, one retry, then a visible
 * dead-letter". A render that failed once will almost always fail again, and each attempt
 * costs a Chromium launch on the box's memory ceiling.
 */
const REPORT_RETRY_POLICY = { retryLimit: 1, retryDelay: 60, retryBackoff: false } as const;

/**
 * The backlog at which pg-boss emits a `queue_backlog` warning, logged by the handler in
 * `onModuleInit`. ~200 jobs/day across every queue (STACK.md §5), so a hundred waiting on
 * one of them means something has stopped consuming.
 */
const WARNING_QUEUE_SIZE = 100;

/**
 * How long a shutdown waits for in-flight jobs before closing the pool.
 *
 * Sized for the longest handler in the deployment: a report render is capped at 120s
 * (STACK.md §5), and cutting one off mid-render loses the Chromium work and leaves the
 * snapshot to be retried. `docker-compose.yml`'s `stop_grace_period` is set above this on
 * every service that runs jobs, so this timeout is the one that expires first.
 */
const QUEUE_DRAIN_TIMEOUT_MS = 150_000;

/** What `/health` reports about the queue (§16.2, §16.12). */
export interface QueueHealth {
  /** Jobs sitting in a dead-letter queue: each one is work that was lost. */
  deadLetterCount: number;
  /** Queues holding dead-lettered jobs, named so the alert says which. */
  deadLetterQueues: string[];
}

/**
 * pg-boss is the only queue and the only enqueue mechanism (DECISIONS.md R-2).
 *
 * It stores its jobs in the same PostgreSQL as the domain writes, which is precisely why
 * it was chosen: `sendInTransaction` enqueues on the caller's own transaction, so a job is
 * never visible to a worker for a domain write that rolled back. A separate
 * transactional-outbox table and dispatcher would be a second mechanism doing that one job,
 * which is why `domain_event` is not in the schema.
 *
 * The guarantee is asserted by a permanent test (`queue.rollback.test.ts`), not assumed.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private boss: PgBoss | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onModuleInit(): Promise<void> {
    this.boss = new PgBoss({
      connectionString: this.config.DATABASE_URL,
      schema: this.config.PGBOSS_SCHEMA,
      // pg-boss opens its own pool beside the application's, and both count against the
      // database's connection limit — on Supabase's session pooler, 15 in all.
      max: this.config.PGBOSS_POOL_MAX,
    });

    this.boss.on('error', (error: unknown) => this.logger.error({ err: error }, 'pg-boss error'));
    // `queue_backlog`, `slow_query`, `clock_skew` and the rest. pg-boss notices these
    // itself; before this handler it noticed them into a listener nobody had registered.
    this.boss.on('warning', (warning) =>
      this.logger.warn(`pg-boss ${warning.message}: ${JSON.stringify(warning.data)}`),
    );
    await this.boss.start();

    await this.applyQueuePolicy();
  }

  /**
   * Create every queue and its dead-letter companion, then apply the policy.
   *
   * The second half is not redundant. `create_queue` is `ON CONFLICT DO NOTHING`, so on a
   * database where the queues already exist — every deployed one, and every test database
   * between runs — passing new options to `createQueue` changes nothing at all. `updateQueue`
   * is what makes a policy change take effect on the queues that are already there, which
   * is the only case that matters after the first boot.
   */
  private async applyQueuePolicy(): Promise<void> {
    const retention = {
      // STACK.md §5: "Set a pg-boss archive-retention policy on day one, or completed jobs
      // become the largest table in the database." In pg-boss 12 that is a queue option,
      // not a constructor one — the constructor had been passed v9 names it ignored.
      deleteAfterSeconds: this.config.PGBOSS_JOB_RETENTION_DAYS * 24 * 60 * 60,
    };

    for (const queue of Object.values(QUEUES)) {
      const deadLetter = deadLetterOf(queue);
      const retries = queue === QUEUES.reportRender ? REPORT_RETRY_POLICY : RETRY_POLICY;

      await this.instance.createQueue(deadLetter, retention);
      await this.instance.updateQueue(deadLetter, { ...retention, deadLetter: null });

      const options = { ...retries, ...retention, deadLetter, warningQueueSize: WARNING_QUEUE_SIZE };
      await this.instance.createQueue(queue, options);
      await this.instance.updateQueue(queue, options);
    }
  }

  /**
   * Drain rather than drop (§16.9's health-gated cutover, PART 14's "graceful shutdown and
   * queue draining").
   *
   * pg-boss's `stop` waits for in-flight handlers to finish before closing the pool, up to
   * `timeout`. The number matters twice over: `docker compose` sends SIGKILL
   * `stop_grace_period` after SIGTERM, so the compose file allows more than this, or the
   * drain this awaits is cut short by the kernel.
   */
  async onModuleDestroy(): Promise<void> {
    const boss = this.boss;
    this.boss = null;
    if (!boss) return;

    const startedAt = Date.now();
    await boss.stop({ graceful: true, timeout: QUEUE_DRAIN_TIMEOUT_MS });
    this.logger.log(`pg-boss drained in ${Date.now() - startedAt}ms`);
  }

  private get instance(): PgBoss {
    if (!this.boss) {
      throw new Error('QueueService used before initialisation');
    }
    return this.boss;
  }

  /**
   * Enqueue **inside** the caller's domain transaction.
   *
   * The job row is written on the same transaction as the business change, so the two
   * commit or roll back together. This is the method to use; `send` exists only for jobs
   * with no accompanying database write.
   */
  async sendInTransaction(
    tx: Transaction,
    queue: QueueName,
    data: object,
    options: PgBossTypes.SendOptions = {},
  ): Promise<string | null> {
    return this.instance.send(queue, data, { ...options, db: fromDrizzle(tx, sql) });
  }

  /** For jobs with no accompanying domain write (a scheduled sweep, say). */
  async send(queue: QueueName, data: object, options: PgBossTypes.SendOptions = {}): Promise<string | null> {
    return this.instance.send(queue, data, options);
  }

  async schedule(
    queue: QueueName,
    cron: string,
    data: object,
    options: PgBossTypes.ScheduleOptions,
  ): Promise<void> {
    await this.instance.schedule(queue, cron, data, options);
  }

  /**
   * How much work has been lost: the live depth of every dead-letter queue (§16.2, §16.12).
   *
   * Counted with a query rather than from `getQueues()`, which returns pg-boss's own
   * *cached* per-queue counters — refreshed by its monitor every 60 seconds by default, and
   * therefore zero for the first minute of every incident. A health check and a dashboard
   * that both read a number a minute behind is how a dead-letter goes unnoticed for exactly
   * as long as anyone is looking at it. Nothing works a dead-letter queue, so every job on
   * one is a job waiting for a human, whatever state it is in.
   *
   * The read is one indexed count over queues that are empty in the healthy case, and it
   * touches pg-boss's own tables rather than a domain table — there is no `unit_id` here to
   * scope by, which is why it is not a repository (AZ-1).
   */
  async queueHealth(): Promise<QueueHealth> {
    const result = await this.db.execute(
      sql`SELECT name, count(*)::int AS n FROM ${sql.identifier(this.config.PGBOSS_SCHEMA)}.job
          WHERE name LIKE ${`%${DEAD_LETTER_SUFFIX}`} GROUP BY name ORDER BY name`,
    );
    const rows = (result as unknown as { rows: Array<{ name: string; n: number }> }).rows;

    return {
      deadLetterCount: rows.reduce((sum, row) => sum + row.n, 0),
      deadLetterQueues: rows.map((row) => row.name),
    };
  }

  /**
   * Register a handler, with §16.1's per-job log line around it: "Every queue job logs
   * start, finish, duration, attempt number."
   *
   * It wraps here rather than in each worker because there are six workers and one of this,
   * and because a log line that only some jobs emit is worse than none — the gap reads as
   * "no jobs ran" when it means "this worker was written later".
   */
  async work<T extends object>(
    queue: QueueName,
    handler: (jobs: PgBossTypes.Job<T>[]) => Promise<void>,
    options: PgBossTypes.WorkOptions = {},
  ): Promise<string> {
    return this.instance.work<T>(queue, { ...options, includeMetadata: true }, async (jobs) => {
      const startedAt = Date.now();
      this.logger.log(`${queue} start ${describe(jobs)}`);
      try {
        await handler(jobs);
        this.logger.log(`${queue} done ${describe(jobs)} in ${Date.now() - startedAt}ms`);
      } catch (error) {
        // Rethrown, always: pg-boss decides retry-or-dead-letter from whether the handler
        // settles, so a swallowed error here would silently complete a job that failed.
        this.logger.error(
          `${queue} failed ${describe(jobs)} after ${Date.now() - startedAt}ms`,
          error instanceof Error ? error.stack : String(error),
        );
        throw error;
      }
    });
  }
}

/**
 * `fromDrizzle` is pg-boss's own adapter: it wraps the Drizzle transaction as the
 * `IDatabase` interface and builds parameterised queries with Drizzle's `sql` tag, so the
 * job INSERT joins the transaction already in progress rather than opening a connection of
 * its own. That is what makes the enqueue transactional, and therefore what makes a
 * separate outbox table unnecessary (R-2).
 */

/**
 * `includeMetadata` is set for every worker above, so `retryCount` is present at runtime
 * even though the handler signature stays the narrower `Job<T>`. The cast is local to the
 * log line: no handler is given the wider type, so none can start depending on it.
 */
function describe(jobs: Array<{ id: string }>): string {
  return jobs
    .map((job) => {
      const attempt = (job as Partial<PgBossTypes.JobWithMetadata>).retryCount;
      return attempt === undefined ? job.id : `${job.id} (attempt ${attempt + 1})`;
    })
    .join(', ');
}
