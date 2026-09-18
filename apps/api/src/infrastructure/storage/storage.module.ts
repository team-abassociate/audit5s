import { Global, Logger, Module } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../../config/env';
import { LocalObjectStorage } from './local-object-storage';
import { LocalObjectStorageController } from './local-object-storage.controller';
import { ObjectStorage } from './object-storage';
import { S3ObjectStorage } from './s3-object-storage';

/**
 * Chooses the object-storage driver from configuration alone.
 *
 * The rule is deliberately blunt: an `S3_ENDPOINT` means the S3 driver, its absence means
 * the filesystem one. A deployment that forgets the endpoint therefore writes to local
 * disk instead of silently succeeding against nothing — and says so in the startup log on
 * every boot.
 *
 * Phase 4 makes the log louder, because the filesystem driver now serves presigned URLs
 * from this process (R-9) and that is a fact a deployment must not discover from a
 * bandwidth graph. The controller is registered either way so the route table is the same
 * in both configurations — the authorization completeness check enumerates registered
 * routes, and a route that appears only under one driver would be a route the matrix
 * could not describe. It answers 404 when the S3 driver is live.
 */
@Global()
@Module({
  controllers: [LocalObjectStorageController],
  providers: [
    {
      provide: ObjectStorage,
      inject: [CONFIG],
      useFactory: (config: AppConfig): ObjectStorage => {
        const logger = new Logger('ObjectStorage');

        if (config.S3_ENDPOINT) {
          const storage = new S3ObjectStorage({
            endpoint: config.S3_ENDPOINT,
            region: config.S3_REGION,
            accessKeyId: config.S3_ACCESS_KEY_ID ?? '',
            secretAccessKey: config.S3_SECRET_ACCESS_KEY ?? '',
            bucket: config.S3_BUCKET,
          });
          logger.log(`using ${storage.describe()} — presigned uploads go direct to the provider`);
          return storage;
        }

        const storage = new LocalObjectStorage(config.OBJECT_STORAGE_LOCAL_DIR, {
          publicBaseUrl: config.OBJECT_STORAGE_PUBLIC_URL,
          ...(config.OBJECT_STORAGE_SIGNING_SECRET
            ? { signingSecret: config.OBJECT_STORAGE_SIGNING_SECRET }
            : {}),
        });
        logger.warn(
          `S3_ENDPOINT is not set — using ${storage.describe()}. This is the development ` +
            'and CI path; a deployed environment must set S3_ENDPOINT. Presigned URLs are ' +
            'signed and expiring, but they are served by this process, so evidence bytes ' +
            'transit the API (DECISIONS.md R-9).',
        );
        return storage;
      },
    },
  ],
  exports: [ObjectStorage],
})
export class StorageModule {}
