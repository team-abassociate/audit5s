import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { audits, devices, evidence, type Database, type Transaction } from '@audit5s/db';
import { COMPLETED_AUDIT_STATUSES, SCORED_AUDIT_TYPES, type ScopeContext } from '@audit5s/domain';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

/** An audit still open on somebody's phone. Identified, so the log line can be acted on. */
export interface StaleAuditRow {
  id: string;
  startedAt: Date | null;
}

/** A device holding an audit it has not sent anything about for too long. */
export interface UnsyncedDeviceRow {
  deviceId: string;
  lastSyncAt: Date | null;
}

/** What the reconciliation compares a recomputation against. */
export interface StoredScoreRow {
  id: string;
  rawScore: number | null;
  maxScore: number | null;
}

/**
 * The reads behind §16.4's nightly data-integrity checks.
 *
 * Every one of them is a count or a small sample over one Unit, because the sweep is
 * scheduled per Unit (R-15c) and a finding is reported per Unit. They are here rather than
 * spread across the evidence, audit and sync repositories for the reason AZ-1 exists: each
 * carries its own scope predicate, and a reader checking that they all do should be able
 * to do it in one file.
 *
 * The caller is the maintenance sweep, which holds the narrow system Super-Admin context
 * already admitted by these tables' RLS policies. The Unit predicate is still applied on
 * every read — the system context widens *who* may read, never *what* a query asks for.
 */
@Injectable()
export class IntegrityRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  private inScope<T>(scope: ScopeContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return work(tx);
    });
  }

  /**
   * Evidence rows whose object never arrived (§16.4's orphan-metadata sweep).
   *
   * `sync_state` is the whole test. The row is inserted at intent with `SYNCING` and only
   * `commit` moves it to `SYNCED` with an `uploaded_at`, so anything else, old enough, is
   * a row describing a photograph that is not in the bucket. Redacted and deleted rows are
   * excluded: their object is *supposed* to be gone (R-5), and reporting them nightly
   * would make every erasure look like a fault.
   *
   * The scope predicate reaches the Unit through the audit, which is the second hop §12.5
   * allows.
   */
  async orphanEvidenceCount(scope: ScopeContext, unitId: string, olderThan: Date): Promise<number> {
    return this.inScope(scope, async (tx) => {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(evidence)
        .innerJoin(audits, eq(audits.id, evidence.auditId))
        .where(
          this.scoped(
            scope,
            { unitId: audits.unitId },
            eq(audits.unitId, unitId),
            ne(evidence.syncState, 'SYNCED'),
            lt(evidence.createdAt, olderThan),
            isNull(evidence.deletedAt),
            isNull(evidence.redactedAt),
          ),
        );
      return row?.count ?? 0;
    });
  }

  /** Audits open on a device for longer than §16.4's window. */
  async staleAudits(scope: ScopeContext, unitId: string, startedBefore: Date): Promise<StaleAuditRow[]> {
    return this.inScope(scope, (tx) =>
      tx
        .select({ id: audits.id, startedAt: audits.startedAt })
        .from(audits)
        .where(
          this.scoped(
            scope,
            { unitId: audits.unitId, ownerUserId: audits.auditorUserId },
            eq(audits.unitId, unitId),
            inArray(audits.status, ['IN_PROGRESS', 'PAUSED']),
            lt(audits.startedAt, startedBefore),
          ),
        )
        .orderBy(audits.startedAt),
    );
  }

  /**
   * Devices that still hold an audit and have gone quiet (§16.4's >48 h).
   *
   * The server cannot see data it has not been sent, so the finding is built from the two
   * things it can see: the device lock on an unfinished audit says the work is on that
   * phone, and `last_sync_at` says nothing has come back. A device that has never synced
   * at all counts — `last_sync_at IS NULL` with an owned audit is the same fact, worse.
   *
   * Revoked devices are excluded: their lock is already gone and their work is already a
   * different conversation.
   */
  async unsyncedDevices(
    scope: ScopeContext,
    unitId: string,
    quietSince: Date,
  ): Promise<UnsyncedDeviceRow[]> {
    return this.inScope(scope, (tx) =>
      tx
        .selectDistinctOn([devices.id], { deviceId: devices.id, lastSyncAt: devices.lastSyncAt })
        .from(audits)
        .innerJoin(devices, eq(devices.id, audits.owningDeviceId))
        .where(
          this.scoped(
            scope,
            { unitId: audits.unitId, ownerUserId: audits.auditorUserId },
            eq(audits.unitId, unitId),
            inArray(audits.status, ['IN_PROGRESS', 'PAUSED']),
            isNull(devices.revokedAt),
            or(isNull(devices.lastSyncAt), lt(devices.lastSyncAt, quietSince)),
          ),
        )
        .orderBy(devices.id),
    );
  }

  /**
   * The reconciliation sample: the most recently completed scored audits of one Unit, with
   * the scores that were stored for them.
   *
   * Walk-bys are excluded because they have nothing to reconcile — §2.7's "no
   * questionnaire, no score", and `ScoringService` deliberately writes them nothing. Rows
   * that were never scored at all (`raw_score IS NULL` on a completed scored audit) are
   * *kept*: a missing number is the drift worth finding.
   */
  async recentScoredAudits(
    scope: ScopeContext,
    unitId: string,
    limit: number,
  ): Promise<StoredScoreRow[]> {
    return this.inScope(scope, (tx) =>
      tx
        .select({ id: audits.id, rawScore: audits.rawScore, maxScore: audits.maxScore })
        .from(audits)
        .where(
          this.scoped(
            scope,
            { unitId: audits.unitId, ownerUserId: audits.auditorUserId },
            eq(audits.unitId, unitId),
            inArray(audits.status, [...COMPLETED_AUDIT_STATUSES]),
            inArray(audits.auditType, [...SCORED_AUDIT_TYPES]),
            isNotNull(audits.completedAt),
          ),
        )
        .orderBy(desc(audits.completedAt))
        .limit(limit),
    );
  }
}
