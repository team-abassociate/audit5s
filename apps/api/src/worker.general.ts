import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { QUEUES, QueueService } from './infrastructure/queue/queue.service';
import { ChecklistImportWorker } from './modules/checklists/import/checklist-import.worker';
import { StructuredLogger } from './common/observability/logger';

/**
 * `worker-general` (STACK.md §4). Same image as the API, different entrypoint, so there is
 * one domain implementation and one deployment artefact.
 *
 * It handles checklist import and notification fan-out. Notifications land in Phase 6; the
 * checklist import is live, and is the reason §12.8 says a workbook is parsed "in a worker"
 * rather than inside a request.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new StructuredLogger(),
  });
  app.enableShutdownHooks();

  const logger = new Logger('worker-general');
  const queue = app.get(QueueService);

  await app.get(ChecklistImportWorker).register(queue);

  await queue.work(QUEUES.maintenanceSweep, async (jobs) => {
    logger.log(`maintenance.sweep: ${jobs.length} job(s)`);
  });

  logger.log('worker-general ready');
}

void bootstrap();
