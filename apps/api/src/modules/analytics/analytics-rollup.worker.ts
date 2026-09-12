import { Injectable } from '@nestjs/common';
import type { ScopeContext } from '@audit5s/domain';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { AnalyticsRepository } from './analytics.repository';

export interface AnalyticsRollupJob {
  unitId: string;
  timezone: string;
}

const SYSTEM_SCOPE: ScopeContext = {
  actor: {
    userId: '00000000-0000-4000-8000-000000000000',
    role: 'SUPER_ADMIN',
    activeUnitId: null,
    unitIds: [],
    deviceId: null,
  },
  resolver: 'organization',
};

@Injectable()
export class AnalyticsRollupWorker {
  constructor(private readonly repository: AnalyticsRepository) {}

  async schedule(queue: QueueService): Promise<void> {
    for (const unit of await this.repository.unitRows(SYSTEM_SCOPE)) {
      await queue.schedule(
        QUEUES.maintenanceSweep,
        '0 2 * * *',
        { unitId: unit.id, timezone: unit.timezone } satisfies AnalyticsRollupJob,
        { key: `analytics:${unit.id}`, tz: unit.timezone, singletonKey: `analytics:${unit.id}` },
      );
    }
  }

  async handle(data: AnalyticsRollupJob, now = new Date()): Promise<void> {
    await this.repository.rollupDay(
      SYSTEM_SCOPE,
      data.unitId,
      data.timezone,
      previousLocalDay(now, data.timezone),
    );
  }
}

export function previousLocalDay(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  const local = new Date(Date.UTC(Number(value('year')), Number(value('month')) - 1, Number(value('day')) - 1));
  return local.toISOString().slice(0, 10);
}
