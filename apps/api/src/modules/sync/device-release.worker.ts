import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../../config/env';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { SyncRepository } from './sync.repository';

/**
 * The D7 grace sweep (§9.5 Layer 1), run by `worker-general`.
 *
 * > Ownership is released on `COMPLETED`, `PAUSED` (after a 24 h grace period), or by a
 * > Super Admin force-release.
 *
 * Phase 3 released on complete and on cancel. This is the middle case: a paused audit
 * keeps its lock for the grace period — an auditor who breaks for lunch must come back to
 * their own work — and then lets go, so a phone that was paused and then dropped does not
 * hold an audit nobody else can pick up.
 *
 * It is deliberately *not* an audit-logged administrative act. Nobody decided anything: a
 * timer expired. The force-release endpoint is the one that records a decision, and it
 * records a human's.
 */
@Injectable()
export class DeviceReleaseWorker {
  private readonly logger = new Logger('device.release');

  constructor(
    private readonly repository: SyncRepository,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async register(queue: QueueService): Promise<void> {
    await queue.work<Record<string, never>>(QUEUES.deviceRelease, async (jobs) => {
      for (const _job of jobs) {
        await this.sweep();
      }
    });
  }

  async sweep(): Promise<number> {
    const released = await this.repository.releaseStalePausedAudits(
      this.config.DEVICE_RELEASE_GRACE_HOURS,
    );

    if (released.length > 0) {
      this.logger.log(
        `released the device lock on ${released.length} audit(s) paused for more than ` +
          `${this.config.DEVICE_RELEASE_GRACE_HOURS}h: ${released.map((a) => a.id).join(', ')}`,
      );
    }
    return released.length;
  }
}
