import { Injectable, Logger } from '@nestjs/common';
import { grantFor, isAllowedImageType, sniffImageType, stripImageMetadata, type ScopeContext } from '@audit5s/domain';
import { ActorRepository } from '../../common/auth/actor.repository';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { KaizensRepository } from './kaizens.repository';

export interface KaizenPhotoJobData {
  photoId: string;
  /** Who committed it. Identity, never authority: the grant is re-read here. */
  userId: string;
}

/**
 * A Kaizen photo's EXIF strip, in `worker-general` (§12.8, R-48). The media worker's rule,
 * for Kaizen's own photo list: structural (`stripImageMetadata`), so an object with nothing
 * to remove — the normal case, since the phone re-encodes — is left byte-identical.
 * No thumbnail: a Kaizen shows two photos, not a gallery of forty.
 */
@Injectable()
export class KaizenPhotoWorker {
  private readonly logger = new Logger('kaizen.photo.process');

  constructor(
    private readonly repository: KaizensRepository,
    private readonly storage: ObjectStorage,
    private readonly actors: ActorRepository,
  ) {}

  async register(queue: QueueService): Promise<void> {
    await queue.work<KaizenPhotoJobData>(QUEUES.kaizenPhotoProcess, async (jobs) => {
      for (const job of jobs) await this.handle(job.data);
    });
  }

  async handle(data: KaizenPhotoJobData): Promise<void> {
    const scope = await this.scopeFor(data.userId);
    if (!scope) {
      throw new Error(`kaizen.photo.process ${data.photoId}: ${data.userId} is no longer usable`);
    }
    const photo = await this.repository.findPhoto(scope, data.photoId);
    // Already sanitised (pg-boss may deliver twice), removed, or out of reach: nothing to do.
    if (!photo || photo.storedChecksumSha256 || photo.deletedAt || !photo.uploadedAt) return;
    if (!isAllowedImageType(photo.contentType)) {
      throw new Error(`kaizen.photo.process ${photo.id}: ${photo.contentType} is not a permitted image type`);
    }

    const original = await this.storage.get(photo.objectKey);
    if (sniffImageType(original) === null) {
      throw new Error(`kaizen.photo.process ${photo.id}: the stored object is not a JPEG, PNG or WebP`);
    }
    const stripped = stripImageMetadata(original, photo.contentType);
    if (stripped === null) {
      this.logger.warn(`${photo.id}: could not parse the ${photo.contentType} container; stored as sent`);
      return;
    }
    if (stripped.removed.length === 0) return;

    this.logger.warn(`${photo.id}: removed ${stripped.removed.join(', ')} — the capture path should have`);
    const written = await this.storage.put(photo.objectKey, Buffer.from(stripped.bytes), photo.contentType);
    await this.repository.recordPhotoSanitised(scope, photo.id, written.checksumSha256);
  }

  /** The committer's own `kaizen:create` scope, as the media worker re-derives `evidence:create`. */
  private async scopeFor(userId: string): Promise<ScopeContext | null> {
    const record = await this.actors.loadActor(userId, null);
    if (!record || !ActorRepository.isUsable(record)) return null;
    const grant = grantFor(record.actor.role, 'kaizen:create');
    if (!grant) return null;
    return { actor: record.actor, resolver: grant.resolver, ...(grant.condition ? { condition: grant.condition } : {}) };
  }
}
