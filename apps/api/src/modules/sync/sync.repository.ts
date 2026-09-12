import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  auditZones,
  audits,
  deviceSyncRecords,
  evidence,
  questionResponses,
  syncConflicts,
  users,
  type Database,
} from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type { ListSyncConflictsQuery, SyncBatchResult } from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

/**
 * The two tables that make offline synchronization diagnosable and lossless (§5.9).
 *
 * `device_sync_record` is telemetry: one row per batch, so "the audit never arrived"
 * becomes a query rather than a shrug. `sync_conflict` is Layer 3 of §9.5 — the quarantine
 * that means the system has no code path which drops field data on the floor.
 */

/** A conflict is scoped through the user who pushed it; PART 6.3 grants reads to SA only. */
const conflictScopeColumns = { recordUserId: syncConflicts.userId };

@Injectable()
export class SyncRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  // ------------------------------------------------------------------- batch record

  /**
   * Claims a batch id, or reports that it is already claimed.
   *
   * `onConflictDoNothing` on the unique `batch_id` is the whole of §9.3's duplicate-batch
   * guarantee. Two devices — or one device retrying through a timeout — race here and
   * exactly one wins; the loser reads the stored verdicts rather than applying anything.
   * Checking first and inserting second would leave the window open that this closes.
   */
  async claimBatch(
    scope: ScopeContext,
    input: {
      batchId: string;
      deviceId: string;
      itemCount: number;
      appVersion: string | null;
      networkType: string | null;
    },
  ): Promise<{ claimed: boolean }> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      // `RETURNING` is safe here — unlike on `sync_conflict` — because
      // `device_sync_record_select` admits the owning user, so the actor inserting can
      // read back what they inserted.
      const rows = await tx
        .insert(deviceSyncRecords)
        .values({
          batchId: input.batchId,
          deviceId: input.deviceId,
          userId: scope.actor.userId,
          direction: 'PUSH',
          itemCount: input.itemCount,
          appVersion: input.appVersion,
          networkType: input.networkType,
          status: 'IN_PROGRESS',
        })
        .onConflictDoNothing({ target: deviceSyncRecords.batchId })
        .returning({ id: deviceSyncRecords.id });

      return { claimed: rows.length > 0 };
    });
  }

  /** The stored verdicts of a batch that was already applied. */
  async findBatch(scope: ScopeContext, batchId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: deviceSyncRecords.id,
          batchId: deviceSyncRecords.batchId,
          userId: deviceSyncRecords.userId,
          status: deviceSyncRecords.status,
          results: deviceSyncRecords.results,
          finishedAt: deviceSyncRecords.finishedAt,
        })
        .from(deviceSyncRecords)
        .where(eq(deviceSyncRecords.batchId, batchId))
        .limit(1);
      return row ?? null;
    });
  }

  async finishBatch(
    scope: ScopeContext,
    batchId: string,
    input: {
      results: SyncBatchResult[];
      acceptedCount: number;
      rejectedCount: number;
      conflictCount: number;
      status: string;
      error: string | null;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(deviceSyncRecords)
        .set({
          finishedAt: new Date(),
          results: input.results,
          acceptedCount: input.acceptedCount,
          rejectedCount: input.rejectedCount,
          conflictCount: input.conflictCount,
          status: input.status,
          error: input.error,
        })
        .where(eq(deviceSyncRecords.batchId, batchId));
    });
  }

  // ---------------------------------------------------------------------- quarantine

  /**
   * Layer 3 of §9.5. **This is the method that must never fail silently.**
   *
   * `incoming_payload` is the full payload the device sent, not a summary of it: a
   * quarantine row without the payload records that something was lost, which is worse
   * than useless. A Super Admin applies it later through the post-completion override,
   * and that is only possible if every field survived.
   */
  async quarantine(
    scope: ScopeContext,
    input: {
      deviceId: string;
      entityType: string;
      entityId: string;
      reason: string;
      incomingPayload: unknown;
      existingPayload: unknown | null;
      batchId: string;
    },
  ): Promise<string> {
    // The id is generated here rather than by `RETURNING`, and that is not a style choice.
    // PostgreSQL applies the **SELECT** policy to an `INSERT ... RETURNING`, and PART 6.3
    // grants `sync_conflict:read` to a Super Admin alone — so returning the id would make
    // the quarantine insert fail for exactly the actor whose work is being quarantined.
    // Losing field data because the row that preserves it could not be read back is the
    // one failure mode this table exists to prevent.
    const id = randomUUID();

    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx.insert(syncConflicts).values({
        id,
        deviceId: input.deviceId,
        userId: scope.actor.userId,
        entityType: input.entityType,
        entityId: input.entityId,
        reason: input.reason,
        incomingPayload: input.incomingPayload,
        existingPayload: input.existingPayload,
        batchId: input.batchId,
      });
    });

    return id;
  }

  async listConflicts(scope: ScopeContext, query: ListSyncConflictsQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        query.resolved ? isNotNull(syncConflicts.resolvedAt) : isNull(syncConflicts.resolvedAt),
        query.entityType ? eq(syncConflicts.entityType, query.entityType) : undefined,
        query.deviceId ? eq(syncConflicts.deviceId, query.deviceId) : undefined,
        query.cursor ? sql`${syncConflicts.id} > ${query.cursor}` : undefined,
      ];

      return tx
        .select({
          id: syncConflicts.id,
          deviceId: syncConflicts.deviceId,
          userId: syncConflicts.userId,
          userName: users.fullName,
          entityType: syncConflicts.entityType,
          entityId: syncConflicts.entityId,
          reason: syncConflicts.reason,
          incomingPayload: syncConflicts.incomingPayload,
          existingPayload: syncConflicts.existingPayload,
          resolvedAt: syncConflicts.resolvedAt,
          resolvedByUserId: syncConflicts.resolvedByUserId,
          resolution: syncConflicts.resolution,
          createdAt: syncConflicts.createdAt,
        })
        .from(syncConflicts)
        .innerJoin(users, eq(users.id, syncConflicts.userId))
        .where(this.scoped(scope, conflictScopeColumns, ...filters))
        .orderBy(asc(syncConflicts.id))
        .limit(query.limit + 1);
    });
  }

  async findConflict(scope: ScopeContext, conflictId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: syncConflicts.id,
          deviceId: syncConflicts.deviceId,
          userId: syncConflicts.userId,
          userName: users.fullName,
          entityType: syncConflicts.entityType,
          entityId: syncConflicts.entityId,
          reason: syncConflicts.reason,
          incomingPayload: syncConflicts.incomingPayload,
          existingPayload: syncConflicts.existingPayload,
          resolvedAt: syncConflicts.resolvedAt,
          resolvedByUserId: syncConflicts.resolvedByUserId,
          resolution: syncConflicts.resolution,
          createdAt: syncConflicts.createdAt,
        })
        .from(syncConflicts)
        .innerJoin(users, eq(users.id, syncConflicts.userId))
        .where(and(eq(syncConflicts.id, conflictId), this.scoped(scope, conflictScopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * Marks a conflict resolved. The payload is **not** cleared, ever.
   *
   * `DISCARD` is a decision about what to act on, not about what to retain — a Super Admin
   * who decides a quarantined answer was superseded has not decided that the record of it
   * should disappear.
   */
  async resolveConflict(
    scope: ScopeContext,
    conflictId: string,
    input: { resolution: 'APPLY' | 'DISCARD'; note: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(syncConflicts)
        .set({
          resolvedAt: new Date(),
          resolvedByUserId: scope.actor.userId,
          resolution: input.resolution,
          resolutionNote: input.note,
        })
        .where(eq(syncConflicts.id, conflictId));
    });
  }

  // ------------------------------------------------------------------------- status

  /** `GET /sync/status` — the server's view of one device (§8.11). */
  async statusFor(scope: ScopeContext, deviceId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const [lastBatch] = await tx
        .select({
          startedAt: deviceSyncRecords.startedAt,
          status: deviceSyncRecords.status,
        })
        .from(deviceSyncRecords)
        .where(eq(deviceSyncRecords.deviceId, deviceId))
        .orderBy(desc(deviceSyncRecords.startedAt))
        .limit(1);

      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [recent] = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(deviceSyncRecords)
        .where(
          and(eq(deviceSyncRecords.deviceId, deviceId), gte(deviceSyncRecords.startedAt, dayAgo)),
        );

      const [unresolved] = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(syncConflicts)
        .where(and(eq(syncConflicts.deviceId, deviceId), isNull(syncConflicts.resolvedAt)));

      // The D7 locks this device still holds. A device that thinks it is finished and a
      // server that still has it owning three audits is exactly the field problem
      // `/sync/status` exists to make visible from the device.
      const owned = await tx
        .select({
          auditId: audits.id,
          status: audits.status,
          unitId: audits.unitId,
          startedAt: audits.startedAt,
        })
        .from(audits)
        .where(and(eq(audits.owningDeviceId, deviceId), eq(audits.auditorUserId, scope.actor.userId)))
        .orderBy(desc(audits.startedAt))
        .limit(50);

      return {
        lastBatchAt: lastBatch?.startedAt ?? null,
        lastBatchStatus: lastBatch?.status ?? null,
        batchesLast24h: recent?.count ?? 0,
        unresolvedConflictCount: unresolved?.count ?? 0,
        owned,
      };
    });
  }

  // ---------------------------------------------------- parent existence, for §9.3

  /**
   * Whether the parents a batch item names exist yet.
   *
   * §9.3: "The server additionally validates parent existence and returns
   * `RETRY_AFTER_PARENT` rather than failing the whole batch, so a device with a
   * partially-torn queue self-heals." These are the reads behind that — deliberately
   * cheap, because they run once per item and a batch holds a hundred.
   */
  async auditExists(scope: ScopeContext, auditId: string): Promise<boolean> {
    return this.exists(scope, sql`SELECT 1 FROM audit WHERE id = ${auditId}::uuid`);
  }

  async auditZoneExists(scope: ScopeContext, auditZoneId: string): Promise<boolean> {
    return this.exists(scope, sql`SELECT 1 FROM audit_zone WHERE id = ${auditZoneId}::uuid`);
  }

  async responseExists(scope: ScopeContext, responseId: string): Promise<boolean> {
    return this.exists(scope, sql`SELECT 1 FROM question_response WHERE id = ${responseId}::uuid`);
  }

  async evidenceExists(scope: ScopeContext, evidenceId: string): Promise<boolean> {
    return this.exists(scope, sql`SELECT 1 FROM evidence WHERE id = ${evidenceId}::uuid`);
  }

  /** Whether the object behind this evidence row has been confirmed (§9.4). */
  async evidenceCommitted(scope: ScopeContext, evidenceId: string): Promise<boolean> {
    return this.exists(
      scope,
      sql`SELECT 1 FROM evidence WHERE id = ${evidenceId}::uuid AND sync_state = 'SYNCED'`,
    );
  }

  private async exists(scope: ScopeContext, query: SQL): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const result = await tx.execute(query);
      return result.rows.length > 0;
    });
  }

  /**
   * The audit an item ultimately belongs to, and its status — the one read the conflict
   * classification of §9.5 needs before it can decide between `CONFLICT` and `REJECTED`.
   *
   * Deliberately **not** scope-filtered: `SCOPE_REVOKED` is one of §9.5's five quarantine
   * reasons, which means the server has to be able to tell "your membership was revoked
   * mid-audit" from "no such audit". A scoped read collapses both into absence, and the
   * field work behind the first is precisely what must not be lost.
   */
  async classifyTarget(scope: ScopeContext, auditId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const result = await tx.execute<{
        id: string;
        status: string;
        unit_id: string;
        auditor_user_id: string;
        owning_device_id: string | null;
        in_scope: boolean;
      }>(sql`
        SELECT a.id, a.status::text AS status, a.unit_id, a.auditor_user_id,
               a.owning_device_id,
               (a.auditor_user_id = ${scope.actor.userId}::uuid
                 OR a.unit_id = ANY (app_actor_unit_ids())) AS in_scope
        FROM audit a
        WHERE a.id = ${auditId}::uuid
      `);
      return result.rows[0] ?? null;
    });
  }

  /** Releases a device's claim on an audit (§9.5 Layer 1). */
  async releaseDevice(scope: ScopeContext, auditId: string): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(audits)
        .set({ owningDeviceId: null, version: sql`${audits.version} + 1` })
        .where(eq(audits.id, auditId))
        .returning({ id: audits.id });
      return row?.id ?? null;
    });
  }

  /**
   * The D7 grace sweep: every PAUSED audit whose lock has been held past the grace period.
   *
   * §9.5: "Ownership is released on `COMPLETED`, `PAUSED` (after a 24 h grace period), or
   * by a Super Admin force-release." Phase 3 released on complete and cancel; this is the
   * middle case, and it is what stops a phone that was paused and then dropped in a canal
   * from holding an audit nobody else can touch.
   */
  async releaseStalePausedAudits(graceHours: number): Promise<Array<{ id: string; unitId: string }>> {
    return this.db.transaction(async (tx) => {
      // No actor: this runs in the maintenance sweep, and the statement is its own
      // authority — it names exactly the rows the rule describes and touches one column.
      await tx.execute(sql`SELECT set_config('app.actor_role', 'SUPER_ADMIN', true)`);
      const rows = await tx
        .update(audits)
        .set({ owningDeviceId: null, version: sql`${audits.version} + 1` })
        .where(
          and(
            eq(audits.status, 'PAUSED'),
            isNotNull(audits.owningDeviceId),
            sql`${audits.pausedAt} < now() - make_interval(hours => ${graceHours})`,
          ),
        )
        .returning({ id: audits.id, unitId: audits.unitId });
      return rows;
    });
  }

  /** Zones of an audit, keyed by id — used to validate a response's parent in one read. */
  async zoneIdsForAudit(scope: ScopeContext, auditId: string): Promise<Set<string>> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const rows = await tx
        .select({ id: auditZones.id })
        .from(auditZones)
        .where(eq(auditZones.auditId, auditId));
      return new Set(rows.map((row) => row.id));
    });
  }

  /** The existing row behind a conflict, so the quarantine records both sides (§5.9). */
  async snapshotResponse(scope: ScopeContext, responseId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: questionResponses.id,
          value: questionResponses.value,
          remark: questionResponses.remark,
          clientUpdatedAt: questionResponses.clientUpdatedAt,
        })
        .from(questionResponses)
        .where(eq(questionResponses.id, responseId))
        .limit(1);
      return row ?? null;
    });
  }

  /** The audit a response belongs to, so an APPLY can reach the override endpoint. */
  async auditIdForResponse(scope: ScopeContext, responseId: string): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({ auditId: questionResponses.auditId })
        .from(questionResponses)
        .where(eq(questionResponses.id, responseId))
        .limit(1);
      return row?.auditId ?? null;
    });
  }

  async snapshotEvidence(scope: ScopeContext, evidenceId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: evidence.id,
          objectKey: evidence.objectKey,
          syncState: evidence.syncState,
          classification: evidence.classification,
        })
        .from(evidence)
        .where(eq(evidence.id, evidenceId))
        .limit(1);
      return row ?? null;
    });
  }
}

export type SyncConflictRow = NonNullable<Awaited<ReturnType<SyncRepository['findConflict']>>>;
