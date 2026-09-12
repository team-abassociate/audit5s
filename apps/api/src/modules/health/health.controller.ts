import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@audit5s/db';
import type { HealthCheck } from '@audit5s/contracts';
import { DATABASE } from '../../infrastructure/database/database.module';
import { QueueService } from '../../infrastructure/queue/queue.service';
import { Public } from '../../common/auth/decorators';

const STARTED_AT = Date.now();

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly queue: QueueService,
  ) {}

  /**
   * Liveness plus a real database round trip. BetterStack polls this, and a health check
   * that does not touch its dependencies reports green while the product is down.
   *
   * The queue check is the other half (§16.2, §16.12). It reports `degraded`, not `error`,
   * for dead-lettered jobs: the response stays 200 so the uptime figure keeps meaning
   * "the API answered", while the body names the queue a human has to go and look at.
   * Only a dependency the API cannot reach is `error`.
   */
  @Public()
  @Get()
  async check(): Promise<HealthCheck> {
    const checks: HealthCheck['checks'] = {};

    const [database, queue] = await Promise.all([this.checkDatabase(), this.checkQueue()]);
    checks.database = database;
    checks.queue = queue;

    const statuses = Object.values(checks).map((check) => check.status);
    const status = statuses.includes('error')
      ? 'error'
      : statuses.includes('degraded')
        ? 'degraded'
        : 'ok';

    return {
      status,
      version: process.env.APP_VERSION ?? 'dev',
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      checks,
    };
  }

  private async checkDatabase(): Promise<HealthCheck['checks'][string]> {
    const startedAt = Date.now();
    try {
      await this.db.execute(sql`SELECT 1`);
      return { status: 'ok', durationMs: Date.now() - startedAt };
    } catch (error) {
      return { status: 'error', detail: detailOf(error), durationMs: Date.now() - startedAt };
    }
  }

  private async checkQueue(): Promise<HealthCheck['checks'][string]> {
    const startedAt = Date.now();
    try {
      const health = await this.queue.queueHealth();
      const durationMs = Date.now() - startedAt;

      if (health.deadLetterCount > 0) {
        return {
          status: 'degraded',
          detail: `${health.deadLetterCount} dead-lettered job(s) on ${health.deadLetterQueues.join(', ')}`,
          durationMs,
        };
      }

      return { status: 'ok', durationMs };
    } catch (error) {
      return { status: 'error', detail: detailOf(error), durationMs: Date.now() - startedAt };
    }
  }
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}
