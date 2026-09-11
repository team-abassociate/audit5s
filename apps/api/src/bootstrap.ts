import multipart from '@fastify/multipart';
import type { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from './config/env';

/**
 * The Fastify adapter options, shared for the same reason the plugins are.
 *
 * `maxParamLength` is raised from Fastify's default of 100 because the filesystem storage
 * driver carries a base64url-encoded object key in one path segment (R-9), and a key like
 * `evidence/{unit}/{audit}/{zone}/{id}.jpg` is around 180 characters encoded. At the
 * default the route answers 414 with `FST_ERR_MAX_PARAM_LENGTH`, which reads like a
 * client error and is not one.
 *
 * It is a ceiling, not a target: nothing else in the API has a parameter longer than a
 * UUID, so this bounds the one route that needs the room rather than removing the limit.
 */
export const FASTIFY_ADAPTER_OPTIONS: ConstructorParameters<typeof FastifyAdapter>[0] = {
  trustProxy: true,
  bodyLimit: 1_048_576,
  maxParamLength: 512,
};

/**
 * The Fastify plugins and parsers the application needs, in one place.
 *
 * They live here rather than in `main.ts` because the end-to-end suites build the
 * application themselves. Phase 3 already hit that: multipart was registered in `main.ts`
 * only, and the checklist upload 415'd in tests alone until the harness registered it
 * again — two copies of one list, which drift the moment either changes.
 */
export async function registerHttpPlugins(
  app: NestFastifyApplication,
  config: Pick<AppConfig, 'CHECKLIST_IMPORT_MAX_BYTES'>,
): Promise<void> {
  // The one multipart endpoint is the checklist workbook upload (§8.5). The limits are
  // §12.8's: one file, no larger than the import cap, and the cap is enforced here as
  // well as in the reader so an oversized body is refused before it is buffered.
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.CHECKLIST_IMPORT_MAX_BYTES, fields: 8 },
  });

  registerRawImageParser(app);
}

/**
 * §12.8's hard cap on an evidence upload. The presigned policy pins the exact size of
 * each object; this is the ceiling below which any of them must fall.
 */
export const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;

/**
 * A raw-body parser for image uploads.
 *
 * Only the filesystem driver's signed storage route receives these (R-9): with
 * `R2_ENDPOINT` set, an evidence PUT goes to the provider and this parser never fires.
 * The default `bodyLimit` is 1 MB, which would refuse every photograph the phone takes,
 * so the limit is raised to §12.8's cap for these content types **only** — the JSON API
 * keeps its 1 MB body limit, because nothing it accepts is legitimately larger.
 */
function registerRawImageParser(app: NestFastifyApplication): void {
  const instance = app.getHttpAdapter().getInstance();

  for (const contentType of ['image/jpeg', 'image/png', 'image/webp']) {
    instance.addContentTypeParser(
      contentType,
      { parseAs: 'buffer', bodyLimit: MAX_EVIDENCE_BYTES },
      (_request: unknown, body: Buffer, done: (error: Error | null, result?: Buffer) => void) => {
        done(null, body);
      },
    );
  }
}
