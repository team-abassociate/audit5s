import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
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

  await app.register(helmet, {
    // The API serves JSON only; the strict CSP that matters is on the web apps.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });

  // Allow-list per environment (§12.15). Never a wildcard with credentials.
  app.enableCors({
    origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : false,
    credentials: true,
    exposedHeaders: ['x-request-id', 'retry-after'],
  });

  await app.listen(config.API_PORT, config.API_HOST);
}

void bootstrap();
