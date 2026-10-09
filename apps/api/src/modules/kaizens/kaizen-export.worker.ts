import { Injectable } from '@nestjs/common';
import type { ScopeContext } from '@audit5s/domain';
import { ActorRepository } from '../../common/auth/actor.repository';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { KaizensService, type KaizenExportJobData } from './kaizens.service';

/**
 * The Kaizen Sheet PDF, in `worker-report` (plans/kaizen-module.md §4.6), the one process
 * with a browser. One job at a time on its own queue, beside `report.render`'s one.
 */
@Injectable()
export class KaizenExportWorker {
  constructor(
    private readonly kaizens: KaizensService,
    private readonly actors: ActorRepository,
  ) {}

  async register(queue: QueueService): Promise<void> {
    await queue.work<KaizenExportJobData>(
      QUEUES.kaizenExport,
      async (jobs) => {
        for (const job of jobs) await this.handle(job.data);
      },
      { batchSize: 1, localConcurrency: 1 },
    );
  }

  async handle(data: KaizenExportJobData): Promise<void> {
    const record = await this.actors.loadActor(data.userId, null);
    if (!record || !ActorRepository.isUsable(record)) {
      throw new Error(`kaizen.export ${data.exportId}: ${data.userId} is no longer usable`);
    }
    // The service re-derives `kaizen:read` from the role, as the request did.
    const scope: ScopeContext = { actor: record.actor, resolver: 'own_unit' };
    await this.kaizens.writeExport(scope, data.kaizenId, data.exportId);
  }
}
