import { Injectable, Logger } from '@nestjs/common';
import { ActorRepository } from '../../common/auth/actor.repository';
import { PushChannel } from '../../infrastructure/push/push-channel';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';

export interface SyncFailureJobData {
  /**
   * Whose device hit the failure.
   *
   * The *identity* travels with the job; the *authority* does not. The role and the
   * account's state are re-read here, the way `ChecklistImportWorker` established, so an
   * account disabled between the push and the notification does not have a message sent
   * on its behalf under yesterday's standing.
   */
  userId: string;
  deviceId: string;
  batchId: string;
  conflictCount: number;
  rejectedCount: number;
}

/**
 * The `SYNC_FAILURE` handler (§7.4), run by `worker-general`.
 *
 * It tells the auditor, and it is honest about what it can and cannot do: with no Firebase
 * project (Q1) the `PushChannel` is the console adapter, so the message is logged rather
 * than delivered. What *is* durable either way is the record — the quarantine rows and the
 * `device_sync_record` — and the admin console renders both, so the operational half of
 * "somebody has to know" works today.
 */
@Injectable()
export class SyncFailureWorker {
  private readonly logger = new Logger('sync.failure');

  constructor(
    private readonly actors: ActorRepository,
    private readonly push: PushChannel,
  ) {}

  async register(queue: QueueService): Promise<void> {
    await queue.work<SyncFailureJobData>(QUEUES.syncFailure, async (jobs) => {
      for (const job of jobs) {
        await this.handle(job.data);
      }
    });
  }

  async handle(data: SyncFailureJobData): Promise<void> {
    const record = await this.actors.loadActor(data.userId, null);
    if (!record || !ActorRepository.isUsable(record)) {
      // Thrown rather than swallowed: an unreported sync failure for an account that has
      // since been disabled is still a sync failure, and pg-boss making it visible in a
      // dead-letter beats it disappearing here.
      throw new Error(
        `sync failure for batch ${data.batchId}: user ${data.userId} is no longer usable, ` +
          'so nobody was told that their field work is in the quarantine',
      );
    }

    const total = data.conflictCount + data.rejectedCount;
    await this.push.send({
      userId: data.userId,
      eventType: 'SYNC_FAILURE',
      title: 'Some of your work needs attention',
      body:
        `${total} item${total === 1 ? '' : 's'} from this device could not be applied and ` +
        'are being held for review. Nothing has been lost.',
      data: { batchId: data.batchId, deviceId: data.deviceId },
    });

    this.logger.warn(
      `batch ${data.batchId} from device ${data.deviceId}: ${data.conflictCount} quarantined, ` +
        `${data.rejectedCount} rejected`,
    );
  }
}
