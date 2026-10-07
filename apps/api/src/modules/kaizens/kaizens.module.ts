import { Module } from '@nestjs/common';
import { KaizenPhotoWorker } from './kaizen-photo.worker';
import { KaizensController } from './kaizens.controller';
import { KaizensRepository } from './kaizens.repository';
import { KaizensService } from './kaizens.service';

/**
 * Kaizen (R-48). Imports nothing of 5S: `sync` calls in to apply Kaizen outbox items, and
 * the dependency runs one way.
 */
@Module({
  controllers: [KaizensController],
  providers: [KaizensService, KaizensRepository, KaizenPhotoWorker],
  exports: [KaizensService, KaizenPhotoWorker],
})
export class KaizensModule {}
