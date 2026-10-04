import { Injectable, Logger } from '@nestjs/common';
import { v5 as uuidv5 } from 'uuid';
import type { IntegrityDigestData } from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { DomainEvents } from '../../infrastructure/queue/domain-events';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { localDay } from '../analytics/analytics-rollup.worker';
import { ScoringService } from '../audits/scoring.service';
import {
  IntegrityRepository,
  type StaleAuditRow,
  type UnsyncedDeviceRow,
} from './integrity.repository';

/**
 * §16.4's thresholds, which that section fixes by name: orphan evidence at 24 h, a stale
 * in-progress audit at 7 days, an unsynced device at 48 h. They are constants rather than
 * environment variables because nothing deployment-specific moves them, and a knob nobody
 * turns is another line in `.env.example` to keep true (R-17c).
 */
const ORPHAN_EVIDENCE_HOURS = 24;
const STALE_AUDIT_DAYS = 7;
const DEVICE_QUIET_HOURS = 48;

/** §16.4 asks for "a sample nightly", not every audit ever completed. */
const SCORE_SAMPLE_SIZE = 20;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Whose night the summary runs in. One organisation, in India (STACK.md); a Unit's own
 * timezone still decides its rollup day.
 * ponytail: one zone for the whole organisation; read it from the organisation when a Unit
 * outside IST is signed.
 */
const NIGHT_TIMEZONE = 'Asia/Kolkata';

/** Fixed, so `integrity.digest.<night>` always maps to the same event id. */
const DIGEST_NAMESPACE = '6f2c1d4e-8a3b-5c7d-9e0f-1a2b3c4d5e6f';

/** One Unit's findings. Every field is a count, so "nothing wrong" is four zeroes. */
export interface IntegrityFindings {
  orphanEvidence: number;
  staleAudits: number;
  unsyncedDevices: number;
  scoreDrift: number;
  /** How many audits the drift number was drawn from, so a zero can be read honestly. */
  auditsSampled: number;
}

export function hasFindings(findings: IntegrityFindings): boolean {
  return (
    findings.orphanEvidence > 0 ||
    findings.staleAudits > 0 ||
    findings.unsyncedDevices > 0 ||
    findings.scoreDrift > 0
  );
}

/**
 * §16.4's data-integrity jobs, on one nightly `integrity.digest` schedule.
 *
 * They rode the per-Unit `maintenance.sweep` tick until D10 asked for one summary a night:
 * a per-Unit job cannot see the other Units, so the summary needs one run over all of them.
 * Still cheap — four reads and a bounded recomputation per Unit per night.
 *
 * Nothing here writes to a domain table and nothing here repairs anything. A sweep that
 * silently fixed an orphan would be a delete by another name, and an audit whose score the
 * night shift rewrote is exactly the kind of change §16.4 exists to notice. The finding
 * goes to a Super Admin through the notification fan-out (R-17) and a human decides.
 */
@Injectable()
export class IntegrityWorker {
  private readonly logger = new Logger('maintenance.integrity');

  constructor(
    private readonly repository: IntegrityRepository,
    private readonly scoring: ScoringService,
    private readonly events: DomainEvents,
  ) {}

  async sweep(scope: ScopeContext, unitId: string, now = new Date()): Promise<IntegrityFindings> {
    const { findings, stale, quiet } = await this.check(scope, unitId, now);

    this.logger.log(
      `unit ${unitId}: ${findings.orphanEvidence} orphan evidence, ${findings.staleAudits} stale ` +
        `audit(s), ${findings.unsyncedDevices} quiet device(s), ${findings.scoreDrift} score ` +
        `drift(s) in ${findings.auditsSampled} sampled`,
    );
    // The counts go to the Super Admin; the identifiers go to whoever has to chase one.
    // A notification saying "1 audit open for more than a week" is not actionable on its
    // own, and the log is where the "which one" belongs — it is not a Super Admin's to read.
    if (stale.length > 0) {
      this.logger.warn(`stale audits: ${stale.map((row) => row.id).join(', ')}`);
    }
    if (quiet.length > 0) {
      this.logger.warn(
        `devices holding work and not syncing: ${quiet
          .map((row) => `${row.deviceId} (last sync ${row.lastSyncAt?.toISOString() ?? 'never'})`)
          .join(', ')}`,
      );
    }

    return findings;
  }

  /** Registers the nightly summary: one schedule for the organisation, not one per Unit. */
  async schedule(queue: QueueService): Promise<void> {
    await queue.schedule(QUEUES.integrityDigest, '0 2 * * *', {}, {
      key: QUEUES.integrityDigest,
      tz: NIGHT_TIMEZONE,
      singletonKey: QUEUES.integrityDigest,
    });
  }

  /**
   * D10: every Unit's checks, then **one** summary to each Super Admin for the night.
   *
   * It used to be one alert per Unit, four of them inside six seconds at 02:00. The checks
   * still run Unit by Unit, each behind its own Unit predicate; only the telling is joined.
   *
   * Idempotent per night: the event id is derived from the date, so a retried or doubled
   * run reaches each Super Admin once (`UNIQUE(event_id, recipient_user_id)`). Only when
   * there is something to say — a nightly "all clear" is a nightly notification, and the
   * sweep's own health is covered by §16.1's per-job log line and the dead-letter queue
   * (R-16a, R-17b).
   */
  async digest(scope: ScopeContext, now = new Date()): Promise<IntegrityDigestData | null> {
    const found: IntegrityDigestData['units'] = [];
    for (const unit of await this.repository.units(scope)) {
      const findings = await this.sweep(scope, unit.id, now);
      if (hasFindings(findings)) found.push({ unitId: unit.id, unitName: unit.name, ...findings });
    }
    if (found.length === 0) return null;

    const data: IntegrityDigestData = { night: localDay(now, NIGHT_TIMEZONE), units: found };
    // No transaction to join: the sweep wrote nothing, so R-2's hazard cannot arise.
    await this.events.emitCommitted({
      type: 'DATA_INTEGRITY_ALERT',
      eventId: uuidv5(`integrity.digest.${data.night}`, DIGEST_NAMESPACE),
      // The system, not a person. Nobody is skipped as "their own act".
      actorUserId: null,
      unitId: null,
      resourceType: 'organization',
      resourceId: null,
      data,
    });
    return data;
  }

  private async check(
    scope: ScopeContext,
    unitId: string,
    now: Date,
  ): Promise<{ findings: IntegrityFindings; stale: StaleAuditRow[]; quiet: UnsyncedDeviceRow[] }> {
    const [orphanEvidence, stale, quiet] = await Promise.all([
      this.repository.orphanEvidenceCount(scope, unitId, new Date(now.getTime() - ORPHAN_EVIDENCE_HOURS * HOUR_MS)),
      this.repository.staleAudits(scope, unitId, new Date(now.getTime() - STALE_AUDIT_DAYS * 24 * HOUR_MS)),
      this.repository.unsyncedDevices(scope, unitId, new Date(now.getTime() - DEVICE_QUIET_HOURS * HOUR_MS)),
    ]);

    const sample = await this.repository.recentScoredAudits(scope, unitId, SCORE_SAMPLE_SIZE);
    let scoreDrift = 0;
    for (const audit of sample) {
      if (await this.hasDrifted(scope, audit)) scoreDrift += 1;
    }

    return {
      findings: {
        orphanEvidence,
        staleAudits: stale.length,
        unsyncedDevices: quiet.length,
        scoreDrift,
        auditsSampled: sample.length,
      },
      stale,
      quiet,
    };
  }

  /**
   * Recompute one audit and compare it with what was stored.
   *
   * `summarise` is the same path the write used, so this is not a second implementation of
   * scoring checking the first — it is the stored *number* being checked against the
   * current code, which is what catches a write that never happened, a response edited
   * around the recompute, or a migration that moved a column.
   *
   * The integers are compared, never `total_score`: that column is a rounded percentage,
   * and a tolerance on it would be a tolerance on the finding.
   */
  private async hasDrifted(
    scope: ScopeContext,
    stored: { id: string; rawScore: number | null; maxScore: number | null },
  ): Promise<boolean> {
    const { audit } = await this.scoring.summarise(scope, stored.id);
    const drifted =
      stored.rawScore !== audit.totals.rawScore || stored.maxScore !== audit.totals.maxScore;

    if (drifted) {
      this.logger.warn(
        `audit ${stored.id}: stored ${stored.rawScore}/${stored.maxScore}, ` +
          `recomputed ${audit.totals.rawScore}/${audit.totals.maxScore}`,
      );
    }
    return drifted;
  }

}
