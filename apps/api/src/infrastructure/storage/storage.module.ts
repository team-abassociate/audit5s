import { Global, Logger, Module } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../../config/env';
import { LocalObjectStorage } from './local-object-storage';
import { ObjectStorage } from './object-storage';
import { S3ObjectStorage } from './s3-object-storage';

/**
 * Chooses the object-storage driver from configuration alone.
 *
 * The rule is deliberately blunt: an `R2_ENDPOINT` means the S3 driver, its absence means
 * the filesystem one. A deployment that forgets the endpoint therefore writes to local
 * disk instead of silently succeeding against nothing — and says so in the startup log on
 * every boot.
 */
@Global()
@Module({
  providers: [
    {
      provide: ObjectStorage,
      inject: [CONFIG],
      useFactory: (config: AppConfig): ObjectStorage => {
        const logger = new Logger('ObjectStorage');

        if (config.R2_ENDPOINT) {
          const storage = new S3ObjectStorage({
            endpoint: config.R2_ENDPOINT,
            region: config.R2_REGION,
            accessKeyId: config.R2_ACCESS_KEY_ID ?? '',
            secretAccessKey: config.R2_SECRET_ACCESS_KEY ?? '',
            bucket: config.R2_BUCKET_IMPORTS,
          });
          logger.log(`using ${storage.describe()}`);
          return storage;
        }

        const storage = new LocalObjectStorage(config.OBJECT_STORAGE_LOCAL_DIR);
        logger.warn(
          `R2_ENDPOINT is not set — using ${storage.describe()}. This is the development ` +
            'and CI path; a deployed environment must set R2_ENDPOINT.',
        );
        return storage;
      },
    },
  ],
  exports: [ObjectStorage],
})
export class StorageModule {}
