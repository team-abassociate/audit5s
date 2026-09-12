import { Injectable, Logger } from '@nestjs/common';
import type { ScopeContext } from '@audit5s/domain';
import { DomainEvents } from '../../infrastructure/queue/domain-events';
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
 * §16.4's data-integrity jobs, riding the per-Unit `maintenance.sweep` tick.
 *
 * They share the tick rather than carrying schedules of their own for the reason the D7
 * grace sweep does: the schedule already exists, the checks are idempotent, and they are
 * cheap — four reads and a bounded recomputation per Unit per night.
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

    // Only when there is something to say. A nightly "all clear" is a nightly notification,
    // and the sweep's own health is already covered by §16.1's per-job log line and by the
    // dead-letter queue if it stops running at all (R-16a).
    if (hasFindings(findings)) {
      await this.notify(unitId, findings);
    }
    return findings;
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

  /**
   * No transaction to join: the sweep read and wrote nothing, so R-2's hazard — a job for a
   * write that rolled back — cannot arise. This is `SYNC_FAILURE`'s case exactly.
   */
  private async notify(unitId: string, findings: IntegrityFindings): Promise<void> {
    await this.events.emitCommitted({
      type: 'DATA_INTEGRITY_ALERT',
      // The system, not a person. Nobody is skipped as "their own act".
      actorUserId: null,
      unitId,
      resourceType: 'unit',
      resourceId: unitId,
      data: { ...findings },
    });
  }
}
