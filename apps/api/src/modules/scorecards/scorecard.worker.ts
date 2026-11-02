import { Injectable } from '@nestjs/common';
import type { ScopeContext } from '@audit5s/domain';
import { ActorRepository } from '../../common/auth/actor.repository';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { ScorecardService, type ScorecardJobData } from './scorecard.service';

/** R-80: the score card PDF, in `worker-report`, one at a time on its own queue. */
@Injectable()
export class ScorecardWorker {
  constructor(
    private readonly scorecards: ScorecardService,
    private readonly actors: ActorRepository,
  ) {}

  async register(queue: QueueService): Promise<void> {
    await queue.work<ScorecardJobData>(
      QUEUES.scorecardExport,
      async (jobs) => {
        for (const job of jobs) await this.handle(job.data);
      },
      { batchSize: 1, localConcurrency: 1 },
    );
  }

  async handle(data: ScorecardJobData): Promise<void> {
    const record = await this.actors.loadActor(data.userId, null);
    if (!record || !ActorRepository.isUsable(record)) {
      throw new Error(`scorecard.export ${data.exportId}: ${data.userId} is no longer usable`);
    }
    // The service re-derives `report:score_summary` from the role, as the request did.
    const scope: ScopeContext = { actor: record.actor, resolver: 'own_unit' };
    await this.scorecards.write(scope, data.auditId, data.exportId);
  }
}
