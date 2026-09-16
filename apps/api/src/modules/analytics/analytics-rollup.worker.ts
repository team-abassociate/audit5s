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

  /**
   * Rebuilds the day an audit completed on, as soon as it completes.
   *
   * The board, the trend and the Zone ranking all read the rollup, so an audit finished at
   * 15:00 used to show `N/A` until the 02:00 run. The rebuild is the same idempotent upsert
   * the nightly job performs, so running it early changes nothing but the wait.
   */
  async refresh(data: AnalyticsRefreshJob): Promise<void> {
    const unit = (await this.repository.unitRows(SYSTEM_SCOPE)).find((row) => row.id === data.unitId);
    if (!unit) return;
    await this.repository.rollupDay(
      SYSTEM_SCOPE,
      unit.id,
      unit.timezone,
      localDay(new Date(data.at), unit.timezone),
    );
  }

  /**
   * Today and yesterday for every Unit, when the worker starts.
   *
   * The nightly job rebuilds only the previous day, so a worker that was down at 02:00 left
   * that day off the board for good, and audits completed before completion began raising
   * a refresh were never picked up at all.
   */
  async catchUp(now = new Date()): Promise<void> {
    for (const unit of await this.repository.unitRows(SYSTEM_SCOPE)) {
      for (const day of [previousLocalDay(now, unit.timezone), localDay(now, unit.timezone)]) {
        await this.repository.rollupDay(SYSTEM_SCOPE, unit.id, unit.timezone, day);
      }
    }
  }
}

/** Raised inside the completing transaction (R-2), so it exists exactly when the audit does. */
export interface AnalyticsRefreshJob {
  unitId: string;
  /** The completion instant. The Unit's timezone decides which local day that is. */
  at: string;
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
