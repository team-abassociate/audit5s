import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import {
  MAX_GET_TTL_SECONDS,
  MAX_PUT_TTL_SECONDS,
  ObjectStorage,
  cappedTtl,
  type PresignPutOptions,
  type PresignedDownload,
  type PresignedUpload,
  type StoredObject,
  type StoredObjectHead,
} from './object-storage';

/**
 * A filesystem adapter, used when no `S3_ENDPOINT` is configured.
 *
 * This exists for one reason: the seed imports the nine department checklists **through
 * the real import pipeline** (HANDOFF.md §5.2), and the end-to-end suites run that same
 * pipeline in CI. Neither has object-storage credentials, and neither should need a
 * running MinIO to prove that a spreadsheet parses. It is a driver behind the same port,
 * not a stub: it really stores bytes and really reads them back.
 *
 * It is not a production path. Production requires `S3_ENDPOINT`, and the startup log
 * says which driver is live so a misconfigured deployment is visible immediately.
 *
 * ---
 *
 * **Presigning on a filesystem — DECISIONS.md R-9.**
 *
 * Phase 4 gave the port `presignPut` and `presignGet`, and a filesystem has no notion of
 * either. §5 says media never transits the API and §12.6 puts a presigned GET at ≤5
 * minutes, so the question is what those two verbs *mean* here. Three answers were
 * available and two are worse:
 *
 *   - Throwing would make every evidence test require MinIO, which cannot be pulled in
 *     this environment and which CI does not run. The media path would then be the one
 *     part of Phase 4 with no test at all — the exact outcome the handoff warns against.
 *   - Returning a plain file path would drop the signature, the expiry and the
 *     content-type constraint together, so the CI path would exercise a *different*
 *     protocol from production and prove nothing about the one that ships.
 *
 * So this driver mints a URL to a signature-gated route this application serves
 * (`__local-object-storage/...`), carrying an HMAC over the method, the key, the expiry
 * and the declared content type and size. Every property the contract depends on is real:
 * the URL expires, a tampered key or type fails the signature, the PUT is refused if the
 * body does not match what was declared, and the route is outside the JWT guard chain
 * exactly as a storage provider is. What is *not* real is the one thing a filesystem
 * cannot give: the bytes go through this process rather than past it.
 *
 * That is why `presignsOffProcess` is false and why the route path is namespaced with a
 * double underscore — it is meant to be conspicuous in an access log. Setting
 * `S3_ENDPOINT` moves the bytes off the process and this driver is never constructed.
 */
@Injectable()
export class LocalObjectStorage extends ObjectStorage {
  private readonly logger = new Logger(LocalObjectStorage.name);
  private readonly root: string;
  private readonly signingSecret: Buffer;
  private readonly publicBaseUrl: string;

  /**
   * `signingSecret` defaults to a value generated per process.
   *
   * That means a restart invalidates every outstanding URL, which for a development and
   * CI driver is the honest default: a signing key with a compiled-in value would be a
   * shared secret in git, and "it's only for tests" is how such a key ends up trusted
   * somewhere it should not be. A long-running dev environment can set
   * `OBJECT_STORAGE_SIGNING_SECRET` to keep URLs valid across restarts.
   */
  constructor(root: string, options: { publicBaseUrl: string; signingSecret?: string }) {
    super();
    this.root = resolve(root);
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');
    this.signingSecret = options.signingSecret
      ? Buffer.from(options.signingSecret, 'utf8')
      : randomBytes(32);
  }

  /**
   * Keys are server-generated (§12.8: "filenames are never used"), but a path built from
   * a key is still resolved and checked rather than trusted — a traversal here would let
   * a key write outside the storage root.
   */
  private pathFor(key: string): string {
    const target = resolve(join(this.root, normalize(key)));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`Object key escapes the storage root: ${key}`);
    }
    return target;
  }

  async put(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    // A filesystem carries no metadata, and `head()` has to report a content type on both
    // drivers or the commit path would have to branch on which one is live. A sidecar is
    // the smallest thing that keeps the port's answer the same shape everywhere.
    await writeFile(`${path}.meta`, JSON.stringify({ contentType }), 'utf8');
    this.logger.debug(`stored ${key} (${body.byteLength} bytes)`);
    return {
      key,
      byteSize: body.byteLength,
      checksumSha256: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    let size: number;
    try {
      const stats = await stat(this.pathFor(key));
      if (!stats.isFile()) return null;
      size = stats.size;
    } catch {
      return null;
    }

    // A filesystem records no checksum alongside the object, so this driver computes one
    // from the bytes it holds. That is affordable here — the objects are local and the
    // suites are small — and it keeps `commit`'s verification identical on both drivers.
    const bytes = await readFile(this.pathFor(key));
    return {
      key,
      byteSize: size,
      contentType: await this.storedContentType(key),
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  /** The content type recorded by `put`, or null for an object written another way. */
  private async storedContentType(key: string): Promise<string | null> {
    try {
      const raw = await readFile(`${this.pathFor(key)}.meta`, 'utf8');
      return (JSON.parse(raw) as { contentType?: string }).contentType ?? null;
    } catch {
      return null;
    }
  }

  async readRange(key: string, length: number): Promise<Buffer | null> {
    let handle;
    try {
      handle = await open(this.pathFor(key), 'r');
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  presignPut(key: string, options: PresignPutOptions): Promise<PresignedUpload> {
    const expiresIn = cappedTtl(options.expiresInSeconds, MAX_PUT_TTL_SECONDS);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

    const url = this.sign('PUT', key, expiresAt, {
      ct: options.contentType,
      sz: String(options.byteSize),
    });

    return Promise.resolve({
      url,
      requiredHeaders: { 'content-type': options.contentType },
      expiresIn,
    });
  }

  presignGet(key: string, options: { expiresInSeconds: number }): Promise<PresignedDownload> {
    const expiresIn = cappedTtl(options.expiresInSeconds, MAX_GET_TTL_SECONDS);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    return Promise.resolve({ url: this.sign('GET', key, expiresAt, {}), expiresIn });
  }

  describe(): string {
    return `file:${this.root}`;
  }

  /** False, and said out loud: this driver's URLs are served by this process (R-9). */
  get presignsOffProcess(): boolean {
    return false;
  }

  // ------------------------------------------------------------------ the signature

  /** The path the signed route is mounted at. Namespaced to be obvious in an access log. */
  static readonly ROUTE_PREFIX = '__local-object-storage';

  /**
   * Object keys have slashes in them — `evidence/{unit}/{audit}/{zone}/{id}.jpg` is one
   * key, not five path segments — so the key travels base64url-encoded in a **single**
   * segment rather than as a wildcard route.
   *
   * That is not a cosmetic choice. A Fastify wildcard under a controller prefix registers
   * as a bare root-level `*` that matches every otherwise-unmatched path in the API, which
   * would put a public, signature-gated handler in front of the whole surface. One
   * parameter position cannot do that, and it also keeps the rule this codebase settled on
   * in Phase 3: one name per parameter position.
   */
  static encodeKey(key: string): string {
    return Buffer.from(key, 'utf8').toString('base64url');
  }

  static decodeKey(encoded: string): string {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  }

  private sign(
    method: 'GET' | 'PUT',
    key: string,
    expiresAt: number,
    extra: Record<string, string>,
  ): string {
    const params = new URLSearchParams({ ...extra, exp: String(expiresAt) });
    params.set('sig', this.signatureFor(method, key, params));
    const segment = LocalObjectStorage.encodeKey(key);
    return `${this.publicBaseUrl}/${LocalObjectStorage.ROUTE_PREFIX}/${segment}?${params.toString()}`;
  }

  /**
   * The HMAC covers the method, the key and **every** query parameter except the
   * signature itself.
   *
   * Covering all of them rather than a chosen few is what makes the content type and the
   * declared size binding: a client that edits `ct` to smuggle a different type past the
   * policy invalidates the signature, which is the same guarantee an S3 presigned policy
   * gives. Parameters are sorted so the string is canonical.
   */
  private signatureFor(method: string, key: string, params: URLSearchParams): string {
    const canonical = [...params.entries()]
      .filter(([name]) => name !== 'sig')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');

    return createHmac('sha256', this.signingSecret)
      .update(`${method}\n${key}\n${canonical}`)
      .digest('hex');
  }

  /**
   * Verifies a request against its signature and expiry.
   *
   * Returns a reason rather than a boolean so the route can log *why* a URL was refused —
   * an expired link and a tampered one are very different operational events, and a
   * single `false` makes them indistinguishable in a support call.
   */
  verify(
    method: 'GET' | 'PUT',
    key: string,
    params: URLSearchParams,
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): { ok: true; contentType: string | null; byteSize: number | null } | { ok: false; reason: string } {
    const signature = params.get('sig');
    if (!signature) {
      return { ok: false, reason: 'MISSING_SIGNATURE' };
    }

    const expected = this.signatureFor(method, key, params);
    const provided = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');

    // Constant-time, and length-checked first because `timingSafeEqual` throws on a
    // length mismatch rather than returning false.
    if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
      return { ok: false, reason: 'BAD_SIGNATURE' };
    }

    const expiresAt = Number(params.get('exp'));
    if (!Number.isFinite(expiresAt) || expiresAt < nowSeconds) {
      return { ok: false, reason: 'EXPIRED' };
    }

    const declaredSize = params.get('sz');
    return {
      ok: true,
      contentType: params.get('ct'),
      byteSize: declaredSize === null ? null : Number(declaredSize),
    };
  }
}
