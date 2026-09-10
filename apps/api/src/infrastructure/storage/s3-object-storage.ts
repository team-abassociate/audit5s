import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ObjectStorage, type StoredObject } from './object-storage';

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

  describe(): string {
    return `s3:${this.config.bucket}`;
  }
}
