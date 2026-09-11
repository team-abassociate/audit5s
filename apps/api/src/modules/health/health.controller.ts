import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@audit5s/db';
import type { HealthCheck } from '@audit5s/contracts';
import { DATABASE } from '../../infrastructure/database/database.module';
import { Public } from '../../common/auth/decorators';

const STARTED_AT = Date.now();

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Liveness plus a real database round trip. BetterStack polls this, and a health check
   * that does not touch its dependencies reports green while the product is down.
   */
  @Public()
  @Get()
  async check(): Promise<HealthCheck> {
    const checks: HealthCheck['checks'] = {};

    const startedAt = Date.now();
    try {
      await this.db.execute(sql`SELECT 1`);
      checks.database = { status: 'ok', durationMs: Date.now() - startedAt };
    } catch (error) {
      checks.database = {
        status: 'error',
        detail: error instanceof Error ? error.message : 'unknown',
        durationMs: Date.now() - startedAt,
      };
    }

    const anyFailed = Object.values(checks).some((check) => check.status === 'error');

    return {
      status: anyFailed ? 'error' : 'ok',
      version: process.env.APP_VERSION ?? 'dev',
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      checks,
    };
  }
}
