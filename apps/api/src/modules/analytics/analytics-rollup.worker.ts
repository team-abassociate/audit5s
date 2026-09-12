import { Injectable } from '@nestjs/common';
import { SYSTEM_SCOPE } from '../../common/auth/system-scope';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { AnalyticsRepository } from './analytics.repository';

export interface AnalyticsRollupJob {
  unitId: string;
  timezone: string;
}

@Injectable()
export class AnalyticsRollupWorker {
  constructor(private readonly repository: AnalyticsRepository) {}

  async schedule(queue: QueueService): Promise<void> {
    for (const unit of await this.repository.unitRows(SYSTEM_SCOPE)) {
      await queue.schedule(
        QUEUES.maintenanceSweep,
        '0 2 * * *',
        { unitId: unit.id, timezone: unit.timezone } satisfies AnalyticsRollupJob,
        // Periods, not colons. pg-boss validates a schedule key against /^[\w.\-/]+$/ and
        // asserts on anything else — a colon here threw before `worker-general` had
        // registered a single handler, so the nightly rollup and the §16.4 sweep that
        // rides the same tick were both scheduled by code that could not run.
        { key: scheduleKey(unit.id), tz: unit.timezone, singletonKey: scheduleKey(unit.id) },
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

/** One stable identity per Unit, in the character set pg-boss accepts for a key. */
export function scheduleKey(unitId: string): string {
  return `analytics.${unitId}`;
}

/**
 * The calendar day an instant falls on **in the Unit's timezone** — the definition of
 * `metric_daily_*.day`.
 *
 * Exported because the reader has to agree with the writer: a range filtered on UTC days
 * against rows bucketed on local days loses the newest day for as long as the two dates
 * differ (05:30 every morning for an Asia/Kolkata Unit). One definition, both sides.
 */
export function localDay(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function previousLocalDay(now: Date, timezone: string): string {
  const [year, month, day] = localDay(now, timezone).split('-').map(Number);
  const local = new Date(Date.UTC(year!, month! - 1, day! - 1));
  return local.toISOString().slice(0, 10);
}
