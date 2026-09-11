import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * The production adapter: any S3-compatible endpoint, which is R2 in the deployed
 * environment and MinIO in `docker-compose.dev.yml`.
 *
 * `forcePathStyle` because R2 and MinIO both address buckets by path rather than by
 * virtual host, and the alternative fails at request time rather than at startup.
 */
@Injectable()
export class S3ObjectStorage extends ObjectStorage {
  private readonly logger = new Logger(S3ObjectStorage.name);
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    super();
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const checksumSha256 = createHash('sha256').update(body).digest('hex');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    this.logger.debug(`stored ${key} (${body.byteLength} bytes)`);
    return { key, byteSize: body.byteLength, checksumSha256 };
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error(`Object ${key} is empty or missing`);
    }
    return Buffer.from(bytes);
  }

  /**
   * The presigned PUT of §9.4.
   *
   * `ChecksumSHA256` is part of the *signed* request, so the provider itself rejects a
   * body whose digest differs from the one the intent declared — the tamper check happens
   * at the edge rather than only at commit. `ContentLength` and `ContentType` are signed
   * for the same reason: §12.6 requires the policy to constrain type, size and the exact
   * key, and a signed header is how an S3-compatible provider expresses that.
   */
  async presignPut(key: string, options: PresignPutOptions): Promise<PresignedUpload> {
    const expiresIn = cappedTtl(options.expiresInSeconds, MAX_PUT_TTL_SECONDS);
    // S3 carries checksums base64-encoded; the rest of this codebase speaks lowercase hex.
    const checksumBase64 = Buffer.from(options.checksumSha256, 'hex').toString('base64');

    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: options.contentType,
        ContentLength: options.byteSize,
        ChecksumSHA256: checksumBase64,
      }),
      { expiresIn },
    );

    return {
      url,
      requiredHeaders: {
        'content-type': options.contentType,
        'content-length': String(options.byteSize),
        'x-amz-checksum-sha256': checksumBase64,
      },
      expiresIn,
    };
  }

  /** §12.6: default 300 s, and the port caps it there whatever a caller asks for. */
  async presignGet(
    key: string,
    options: { expiresInSeconds: number },
  ): Promise<PresignedDownload> {
    const expiresIn = cappedTtl(options.expiresInSeconds, MAX_GET_TTL_SECONDS);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn },
    );
    return { url, expiresIn };
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        key,
        byteSize: response.ContentLength ?? 0,
        contentType: response.ContentType ?? null,
        // Present when the object was uploaded with the checksum the intent signed. Null
        // for anything written another way, and the commit path handles null rather than
        // treating it as a mismatch.
        checksumSha256: response.ChecksumSHA256
          ? Buffer.from(response.ChecksumSHA256, 'base64').toString('hex')
          : null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * A ranged GET, so §12.8's magic-byte sniff costs twelve bytes rather than a whole
   * photo. On a phase that commits one request per photo, the difference is the whole
   * evidence bandwidth of the deployment.
   */
  async readRange(key: string, length: number): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Range: `bytes=0-${Math.max(0, length - 1)}`,
        }),
      );
      const bytes = await response.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  describe(): string {
    return `s3:${this.config.bucket}`;
  }

  /** True: the device PUTs to the provider, and the bytes never reach this process (§5). */
  get presignsOffProcess(): boolean {
    return true;
  }
}

/** A missing object is an answer, not a failure; anything else is a real error. */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}
