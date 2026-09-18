import { Controller, Get, Header, Logger, Param, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/decorators';
import { LocalObjectStorage } from './local-object-storage';
import { ObjectStorage } from './object-storage';

/**
 * The route the filesystem driver's presigned URLs point at (DECISIONS.md R-9).
 *
 * It is the stand-in for a storage provider, not an API endpoint, and it is shaped to be
 * exactly as trusted as one:
 *
 *   - `@Public()`, because a presigned URL carries its own authority. That is the whole
 *     point of presigning — §5 has the device upload without an API session, so a route
 *     that demanded a JWT would be testing a different protocol from the one that ships.
 *   - Every request is verified against the HMAC and the expiry before a byte is read or
 *     written. An unsigned, tampered or stale URL gets 403 and touches no file.
 *   - When `S3_ENDPOINT` is configured this route is dead: the S3 driver is active, its
 *     URLs point at the provider, and this returns 404 rather than quietly offering a
 *     second way in.
 *
 * The `__` prefix is deliberate. This should be conspicuous in an access log, because a
 * production deployment that finds traffic here has a misconfiguration, not a feature.
 */
@Controller(LocalObjectStorage.ROUTE_PREFIX)
export class LocalObjectStorageController {
  private readonly logger = new Logger('LocalObjectStorage');

  constructor(private readonly storage: ObjectStorage) {}

  /**
   * The presigned PUT.
   *
   * The key arrives base64url-encoded in one segment rather than as a wildcard: a Fastify
   * wildcard under a controller prefix registers as a root-level `*` that would match
   * every otherwise-unmatched path in the API.
   */
  @Public()
  @Put(':encodedKey')
  async upload(
    @Param('encodedKey') encodedKey: string,
    @Query() query: Record<string, string>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const driver = this.activeDriver();
    if (!driver) return this.notFound(reply);

    const { key, params } = describe(encodedKey, query);
    const verdict = driver.verify('PUT', key, params);
    if (!verdict.ok) return this.refuse(reply, 'PUT', key, verdict.reason);

    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      // Registered with a raw body parser for this content type; anything else means the
      // parser did not run, and writing `[object Object]` to disk would be worse than 400.
      await reply.code(400).send({ error: 'EXPECTED_RAW_BODY' });
      return;
    }

    // The declared size is part of the signature, so this is the same constraint an S3
    // policy's `ContentLength` imposes: a client cannot sign for 200 KB and send 20 MB.
    if (verdict.byteSize !== null && body.byteLength !== verdict.byteSize) {
      await reply.code(400).send({ error: 'SIZE_MISMATCH', expected: verdict.byteSize });
      return;
    }

    const contentType = verdict.contentType ?? 'application/octet-stream';
    const declaredType = String(request.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (declaredType && declaredType !== contentType) {
      await reply.code(400).send({ error: 'CONTENT_TYPE_MISMATCH', expected: contentType });
      return;
    }

    await driver.put(key, body, contentType);
    await reply.code(200).send({ ok: true });
  }

  @Public()
  @Get(':encodedKey')
  @Header('cache-control', 'private, no-store')
  @Header('cross-origin-resource-policy', 'cross-origin')
  async download(
    @Param('encodedKey') encodedKey: string,
    @Query() query: Record<string, string>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const driver = this.activeDriver();
    if (!driver) return this.notFound(reply);

    const { key, params } = describe(encodedKey, query);
    const verdict = driver.verify('GET', key, params);
    if (!verdict.ok) return this.refuse(reply, 'GET', key, verdict.reason);

    const head = await driver.head(key);
    if (!head) {
      await reply.code(404).send({ error: 'NOT_FOUND' });
      return;
    }

    const bytes = await driver.get(key);
    await reply
      .code(200)
      .header('content-type', head.contentType ?? 'application/octet-stream')
      .header('content-length', String(bytes.byteLength))
      .send(bytes);
  }

  /** Null when the S3 driver is active, which makes this route a 404. */
  private activeDriver(): LocalObjectStorage | null {
    return this.storage instanceof LocalObjectStorage ? this.storage : null;
  }

  private async notFound(reply: FastifyReply): Promise<void> {
    await reply.code(404).send({ error: 'NOT_FOUND' });
  }

  private async refuse(
    reply: FastifyReply,
    method: string,
    key: string,
    reason: string,
  ): Promise<void> {
    // Logged with the reason, because an expired link and a tampered one are very
    // different operational events and a bare 403 makes them indistinguishable.
    this.logger.warn(`refused ${method} ${key}: ${reason}`);
    await reply.code(403).send({ error: reason });
  }
}

/** The real object key, and the query parameters the signature covers. */
function describe(
  encodedKey: string,
  query: Record<string, string>,
): { key: string; params: URLSearchParams } {
  return { key: LocalObjectStorage.decodeKey(encodedKey), params: new URLSearchParams(query) };
}
