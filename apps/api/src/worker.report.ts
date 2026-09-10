import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { QUEUES, QueueService } from './infrastructure/queue/queue.service';
import { StructuredLogger } from './common/observability/logger';

/**
 * `worker-report` (STACK.md §4/§5): PDF rendering, concurrency 1, 1536m.
 *
 * Rendering never happens inside an HTTP request — the API enqueues `report.render` and
 * returns 202. The renderer itself arrives in Phase 7; the process and its concurrency
 * limit exist now because the compose file references them.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new StructuredLogger(),
  });
  app.enableShutdownHooks();

  const logger = new Logger('worker-report');
  const queue = app.get(QueueService);

  await queue.work(
    QUEUES.reportRender,
    async (jobs) => {
      logger.log(`report.render: ${jobs.length} job(s)`);
    },
    // Concurrency 1: a second headless Chrome on a 12 GB box is how Postgres gets OOM-killed.
    { batchSize: 1 },
  );

  logger.log('worker-report ready');
}

void bootstrap();
