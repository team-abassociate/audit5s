import { Injectable, Logger } from '@nestjs/common';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';

/**
 * `SYNC_FAILURE` (§7.4).
 *
 * > Emits SYNC_FAILURE. Row and file are retained on the device; logout is blocked while
 * > any item is not SYNCED.
 *
 * The event is enqueued on pg-boss, and the work it triggers — resolving who to tell, and
 * telling them — happens in `worker-general` under an identity re-read from the database
 * (R-2, and the rule the `ChecklistImportWorker` established: identity travels, authority
 * does not).
 *
 * It is deliberately *not* enqueued inside the batch's own transaction. There is no single
 * domain transaction to join: a batch is a hundred independent writes, each committed on
 * its own so one bad row cannot roll back ninety-nine good ones (§9.3). The thing the
 * event reports — that a quarantine row exists — is already durable by the time this runs,
 * so the R-2 hazard it guards against (a job for a write that rolled back) cannot arise.
 */
@Injectable()
export class SyncEventsService {
  private readonly logger = new Logger('sync.events');

  constructor(private readonly queue: QueueService) {}

  async raiseSyncFailure(input: {
    userId: string;
    deviceId: string;
    batchId: string;
    conflictCount: number;
    rejectedCount: number;
  }): Promise<void> {
    try {
      await this.queue.send(QUEUES.syncFailure, {
        // Identity, never authority: the worker re-reads the role and the grant.
        userId: input.userId,
        deviceId: input.deviceId,
        batchId: input.batchId,
        conflictCount: input.conflictCount,
        rejectedCount: input.rejectedCount,
      });
    } catch (error) {
      // A failure to *report* a failure must not fail the batch: the quarantine rows are
      // already committed, and losing the notification is recoverable where losing the
      // response is not. Logged loudly so it is not invisible.
      this.logger.error(
        { err: error },
        `could not enqueue SYNC_FAILURE for batch ${input.batchId}`,
      );
    }
  }
}
