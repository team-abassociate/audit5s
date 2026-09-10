import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { QUEUES, QueueService } from './infrastructure/queue/queue.service';
import { StructuredLogger } from './common/observability/logger';

/**
 * `worker-general` (STACK.md §4). Same image as the API, different entrypoint, so there is
 * one domain implementation and one deployment artefact.
 *
 * It handles checklist import and notification fan-out. Those land in Phases 2 and 6; what
 * exists now is the process, its queue registration and its shutdown behaviour, so the
 * container in `docker-compose.yml` is real rather than a placeholder.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new StructuredLogger(),
  });
  app.enableShutdownHooks();

  const logger = new Logger('worker-general');
  const queue = app.get(QueueService);

  await queue.work(QUEUES.maintenanceSweep, async (jobs) => {
    logger.log(`maintenance.sweep: ${jobs.length} job(s)`);
  });

  logger.log('worker-general ready');
}

void bootstrap();
