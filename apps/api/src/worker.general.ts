import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { QUEUES, QueueService } from './infrastructure/queue/queue.service';
import { ChecklistImportWorker } from './modules/checklists/import/checklist-import.worker';
import { DeviceReleaseWorker } from './modules/sync/device-release.worker';
import { SyncFailureWorker } from './modules/sync/sync-failure.worker';
import { StructuredLogger } from './common/observability/logger';

/**
 * `worker-general` (STACK.md §4). Same image as the API, different entrypoint, so there is
 * one domain implementation and one deployment artefact.
 *
 * It handles checklist import, the `SYNC_FAILURE` event of §7.4, and the D7 grace sweep
 * of §9.5. Notification fan-out lands in Phase 6; the checklist import is live, and is the
 * reason §12.8 says a workbook is parsed "in a worker" rather than inside a request.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new StructuredLogger(),
  });
  app.enableShutdownHooks();

  const logger = new Logger('worker-general');
  const queue = app.get(QueueService);

  await app.get(ChecklistImportWorker).register(queue);
  await app.get(SyncFailureWorker).register(queue);
  await app.get(DeviceReleaseWorker).register(queue);

  await queue.work(QUEUES.maintenanceSweep, async (jobs) => {
    logger.log(`maintenance.sweep: ${jobs.length} job(s)`);
    // The D7 grace sweep rides the general maintenance tick rather than carrying a
    // schedule of its own: it is idempotent, cheap, and the tick already exists.
    await app.get(DeviceReleaseWorker).sweep();
  });

  logger.log('worker-general ready');
}

void bootstrap();
