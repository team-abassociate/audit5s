import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle } from 'pg-boss';
import type * as PgBossTypes from 'pg-boss';
import type { Transaction } from '@audit5s/db';
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

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    this.boss = new PgBoss({
      connectionString: this.config.DATABASE_URL,
      schema: this.config.PGBOSS_SCHEMA,
      // Set on day one, or completed jobs become the largest table in the database
      // (STACK.md §5).
      archiveCompletedAfterSeconds: this.config.PGBOSS_ARCHIVE_COMPLETED_AFTER_SECONDS,
      deleteAfterDays: this.config.PGBOSS_DELETE_ARCHIVED_AFTER_DAYS,
    } as unknown as ConstructorParameters<typeof PgBoss>[0]);

    this.boss.on('error', (error: unknown) => this.logger.error({ err: error }, 'pg-boss error'));
    await this.boss.start();

    for (const queue of Object.values(QUEUES)) {
      await this.boss.createQueue(queue);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true });
    this.boss = null;
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

  async failedCount(): Promise<number> {
    return (await this.instance.getQueues()).reduce((sum, queue) => sum + queue.failedCount, 0);
  }

  async work<T extends object>(
    queue: QueueName,
    handler: (jobs: PgBossTypes.Job<T>[]) => Promise<void>,
    options: PgBossTypes.WorkOptions = {},
  ): Promise<string> {
    return this.instance.work<T>(queue, options, handler);
  }
}

/**
 * `fromDrizzle` is pg-boss's own adapter: it wraps the Drizzle transaction as the
 * `IDatabase` interface and builds parameterised queries with Drizzle's `sql` tag, so the
 * job INSERT joins the transaction already in progress rather than opening a connection of
 * its own. That is what makes the enqueue transactional, and therefore what makes a
 * separate outbox table unnecessary (R-2).
 */
