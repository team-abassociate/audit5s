import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { QueueService } from './infrastructure/queue/queue.service';
import { StructuredLogger } from './common/observability/logger';
import { ReportWorker } from './modules/reports/report.worker';
import { KaizenExportWorker } from './modules/kaizens/kaizen-export.worker';

/**
 * `worker-report` (STACK.md §4/§5): PDF rendering, concurrency 1, 1536m.
 *
 * Rendering never happens inside an HTTP request — the API enqueues `report.render` and
 * returns 202. This is the only process in the deployment that starts a browser, which is
 * why it is the only one with a memory limit sized for one.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new StructuredLogger(),
  });
  app.enableShutdownHooks();

  const logger = new Logger('worker-report');
  const queue = app.get(QueueService);

  await app.get(ReportWorker).register(queue);
  // The Kaizen Sheet prints on the same browser, from its own queue, so it never waits
  // behind a 5S report nor holds one up.
  await app.get(KaizenExportWorker).register(queue);

  logger.log('worker-report ready');
}

void bootstrap();
