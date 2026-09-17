import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { QUEUES, QueueService } from './infrastructure/queue/queue.service';
import { ChecklistImportWorker } from './modules/checklists/import/checklist-import.worker';
import { MediaWorker } from './modules/evidence/media.worker';
import { DeviceReleaseWorker } from './modules/sync/device-release.worker';
import { NotificationWorker } from './modules/notifications/notification.worker';
import { StructuredLogger } from './common/observability/logger';
import { SYSTEM_SCOPE } from './common/auth/system-scope';
import { OverdueActionsWorker } from './modules/corrective-actions/overdue.worker';
import { IntegrityWorker } from './modules/maintenance/integrity.worker';
import {
  AnalyticsRollupWorker,
  type AnalyticsRefreshJob,
  type AnalyticsRollupJob,
} from './modules/analytics/analytics-rollup.worker';

/**
 * `worker-general` (STACK.md §4). Same image as the API, different entrypoint, so there is
 * one domain implementation and one deployment artefact.
 *
 * It handles checklist import, the media pipeline of §5.4, notification fan-out (§4.2 —
 * `SYNC_FAILURE` among them), the D7 grace sweep of §9.5, and §16.4's nightly
 * data-integrity checks.
 *
 * §12.8 is the reason two of those are here rather than in a request: a workbook is
 * "parsed in a worker with a memory cap", and "images [are] decoded only in the sandboxed
 * media worker with resource limits, never in the API process". Both are operations whose
 * cost is set by the *content* of the input rather than its size.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new StructuredLogger(),
  });
  app.enableShutdownHooks();

  const logger = new Logger('worker-general');
  const queue = app.get(QueueService);

  await app.get(ChecklistImportWorker).register(queue);
  await app.get(MediaWorker).register(queue);
  await app.get(NotificationWorker).register(queue);
  await app.get(DeviceReleaseWorker).register(queue);
  const analytics = app.get(AnalyticsRollupWorker);
  await analytics.schedule(queue);
  const integrity = app.get(IntegrityWorker);
  const overdue = app.get(OverdueActionsWorker);

  await queue.work<AnalyticsRollupJob>(QUEUES.maintenanceSweep, async (jobs) => {
    logger.log(`maintenance.sweep: ${jobs.length} job(s)`);
    // The D7 grace sweep rides the general maintenance tick rather than carrying a
    // schedule of its own: it is idempotent, cheap, and the tick already exists.
    await app.get(DeviceReleaseWorker).sweep();
    for (const job of jobs) {
      if (!job.data.unitId || !job.data.timezone) continue;
      await analytics.handle(job.data);
      // §16.4's checks ride the same per-Unit tick (R-17). They run after the rollup, and
      // deliberately in the same handler: a sweep that raised its own job would be a
      // second schedule to keep in step with this one for no gain.
      await integrity.sweep(SYSTEM_SCOPE, job.data.unitId);
      // §7.3's due dates, on the same tick and for the same reason: it already exists,
      // the sweep is idempotent, and a second schedule would only be a second thing to
      // keep in step with this one.
      await overdue.sweep(SYSTEM_SCOPE, job.data.unitId);
    }
  });

  // The day an audit completed on, rebuilt as soon as it completes, so the board shows it.
  await queue.work<AnalyticsRefreshJob>(QUEUES.analyticsRollup, async (jobs) => {
    for (const job of jobs) {
      await analytics.refresh(job.data);
    }
  });

  // A missed 02:00 run, or audits completed before this worker last started, would otherwise
  // stay off the board. Idempotent, so a restart costs a few upserts and nothing else.
  await analytics.catchUp().catch((error: unknown) => {
    logger.error(`analytics catch-up failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  logger.log('worker-general ready');
}

void bootstrap();
