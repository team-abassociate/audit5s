import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { API_BASE_PATH } from '@audit5s/contracts';
import { AppModule } from './app.module';
import { CONFIG, type AppConfig } from './config/env';
import { StructuredLogger } from './common/observability/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1_048_576 }),
    { logger: new StructuredLogger() },
  );

  const config = app.get<AppConfig>(CONFIG);

  app.setGlobalPrefix(API_BASE_PATH);
  app.enableShutdownHooks();

  // The one multipart endpoint is the checklist workbook upload (§8.5). The limits are
  // §12.8's: one file, no larger than the import cap, and the cap is enforced here as
  // well as in the reader so an oversized body is refused before it is buffered.
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.CHECKLIST_IMPORT_MAX_BYTES, fields: 8 },
  });

  await app.register(helmet, {
    // The API serves JSON only; the strict CSP that matters is on the web apps.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });

  // Allow-list per environment (§12.15). Never a wildcard with credentials.
  //
  // The methods are named rather than defaulted: the default is `GET,HEAD,POST`, which
  // silently refused every `PATCH` and `PUT` the admin app makes — editing a Unit, editing
  // a Zone, and every audit upsert in §8.6. It fails as a browser "Failed to fetch" with
  // no server-side trace, so it is exactly the kind of thing that is invisible until a
  // browser-driven walkthrough runs against a live API.
  app.enableCors({
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    exposedHeaders: ['x-request-id', 'retry-after'],
  });

  await app.listen(config.API_PORT, config.API_HOST);
}

void bootstrap();
