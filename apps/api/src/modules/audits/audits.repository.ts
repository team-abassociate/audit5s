import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, notExists, sql, type SQL } from 'drizzle-orm';
import {
  auditLogs,
  auditZoneSectionScores,
  auditZones,
  audits,
  checklistQuestions,
  checklistTemplates,
  checklistVersions,
  evidence,
  questionResponses,
  unitMemberships,
  units,
  users,
  zones,
  type Database,
  type Transaction,
} from '@audit5s/db';
import { numericScoreFor, type ScopeContext } from '@audit5s/domain';
import type {
  AuditType,
  ListAuditsQuery,
  LocationProvider,
  ResponseValue,
  SSection,
} from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { scopeFor } from '../../common/auth/scope-for';
import { setActorContext } from '../users/users.repository';

/**
 * The audit aggregate: `audit`, its `audit_zone`s, their `question_response`s and the
 * materialised section scores.
 *
 * They live in one repository because they are one write boundary — completing a Zone
 * writes responses, section scores and the Zone row, and completing an audit rewrites
 * every score under it. Splitting that across three repositories would mean a service
 * opening the transaction, which AZ-1 puts here instead.
 */

/** The scope columns of the audit table: PART 6 gives audits both a Unit and an owner. */
const auditScopeColumns = { unitId: audits.unitId, ownerUserId: audits.auditorUserId };

const auditColumns = {
  id: audits.id,
  assignmentId: audits.assignmentId,
  unitId: audits.unitId,
  unitName: units.name,
  auditType: audits.auditType,
  status: audits.status,
  auditorUserId: audits.auditorUserId,
  auditorName: users.fullName,
  owningDeviceId: audits.owningDeviceId,
  checklistVersionId: audits.checklistVersionId,
  selfieEvidenceId: audits.selfieEvidenceId,
  startedAt: audits.startedAt,
  completedAt: audits.completedAt,
  closedAt: audits.closedAt,
  startLatitude: audits.startLatitude,
  startLongitude: audits.startLongitude,
  startAccuracyM: audits.startAccuracyM,
  startLocationProvider: audits.startLocationProvider,
  startLocationIsMocked: audits.startLocationIsMocked,
  startDistanceFromUnitM: audits.startDistanceFromUnitM,
  locationSuspicious: audits.locationSuspicious,
  totalScore: audits.totalScore,
  applicableQuestions: audits.applicableQuestions,
  naQuestions: audits.naQuestions,
  rawScore: audits.rawScore,
  maxScore: audits.maxScore,
  pausedAt: audits.pausedAt,
  pauseReason: audits.pauseReason,
  resumeAuditZoneId: audits.resumeAuditZoneId,
  clientCreatedAt: audits.clientCreatedAt,
  clientUpdatedAt: audits.clientUpdatedAt,
  serverReceivedAt: audits.serverReceivedAt,
  version: audits.version,
  createdAt: audits.createdAt,
  updatedAt: audits.updatedAt,
};

const auditZoneColumns = {
  id: auditZones.id,
  auditId: auditZones.auditId,
  zoneId: auditZones.zoneId,
  sequenceNo: auditZones.sequenceNo,
  status: auditZones.status,
  zoneCodeSnapshot: auditZones.zoneCodeSnapshot,
  zoneNameSnapshot: auditZones.zoneNameSnapshot,
  zoneDescriptionSnapshot: auditZones.zoneDescriptionSnapshot,
  zoneLeaderUserIdSnapshot: auditZones.zoneLeaderUserIdSnapshot,
  zoneLeaderNameSnapshot: auditZones.zoneLeaderNameSnapshot,
  checklistVersionId: auditZones.checklistVersionId,
  checklistTemplateNameSnapshot: auditZones.checklistTemplateNameSnapshot,
  zoneRemark: auditZones.zoneRemark,
  scorePercentage: auditZones.scorePercentage,
  applicableQuestions: auditZones.applicableQuestions,
  naQuestions: auditZones.naQuestions,
  rawScore: auditZones.rawScore,
  maxScore: auditZones.maxScore,
  resumeQuestionId: auditZones.resumeQuestionId,
  startedAt: auditZones.startedAt,
  completedAt: auditZones.completedAt,
  clientUpdatedAt: auditZones.clientUpdatedAt,
  version: auditZones.version,
};

export interface CreateAuditInput {
  id: string;
  assignmentId: string | null;
  unitId: string;
  auditType: AuditType;
  status: 'ASSIGNED' | 'READY';
  auditorUserId: string;
  checklistVersionId: string | null;
  selfieEvidenceId: string | null;
  owningDeviceId: string | null;
  clientCreatedAt: Date;
  location: {
    latitude: number;
    longitude: number;
    accuracyM: number | null;
    provider: LocationProvider;
    isMocked: boolean;
  } | null;
  /**
   * §12.9's server-side assessment: the distance from the Unit's own coordinates, and
   * whether the reading is flagged. Computed by `packages/domain`, never by the client —
   * "never trusting a client-computed distance" is the section's own wording.
   */
  locationAssessment: { distanceM: number | null; suspicious: boolean };
}

/** The D6 snapshot, read from the live Zone at creation and never again. */
export interface ZoneSnapshot {
  zoneCodeSnapshot: string;
  zoneNameSnapshot: string;
  zoneDescriptionSnapshot: string | null;
  zoneLeaderUserIdSnapshot: string | null;
  zoneLeaderNameSnapshot: string | null;
  checklistTemplateNameSnapshot: string | null;
}

export interface ScoreWrite {
  applicableQuestions: number;
  naQuestions: number;
  rawScore: number;
  maxScore: number;
  scorePercentage: number | null;
}

@Injectable()
export class AuditsRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  // ------------------------------------------------------------------------ audits

  async create(scope: ScopeContext, input: CreateAuditInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx.insert(audits).values({
        id: input.id,
        assignmentId: input.assignmentId,
        unitId: input.unitId,
        auditType: input.auditType,
        status: input.status,
        auditorUserId: input.auditorUserId,
        checklistVersionId: input.checklistVersionId,
        selfieEvidenceId: input.selfieEvidenceId,
        owningDeviceId: input.owningDeviceId,
        clientCreatedAt: input.clientCreatedAt,
        clientUpdatedAt: input.clientCreatedAt,
        startDistanceFromUnitM: input.locationAssessment.distanceM?.toFixed(2) ?? null,
        locationSuspicious: input.locationAssessment.suspicious,
        ...(input.location
          ? {
              startLatitude: input.location.latitude.toFixed(6),
              startLongitude: input.location.longitude.toFixed(6),
              startAccuracyM: input.location.accuracyM?.toFixed(2) ?? null,
              startLocationProvider: input.location.provider,
              startLocationIsMocked: input.location.isMocked,
            }
          : {}),
      });
    });
  }

  async findById(scope: ScopeContext, auditId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return this.readAudit(tx, scope, auditId);
    });
  }

  /**
   * Reads an audit by id **without** a scope predicate, for the creation-idempotency path
   * alone (§8.6: "same `id` returns the existing audit").
   *
   * A device retrying `POST /audits` must be told the audit already exists even when the
   * row belongs to someone else — otherwise the retry inserts and hits a primary-key
   * violation the client cannot interpret. The caller compares the auditor and refuses
   * with a conflict; it never returns the row to a stranger.
   */
  async findForCreateIdempotency(scope: ScopeContext, auditId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: audits.id,
          auditorUserId: audits.auditorUserId,
          unitId: audits.unitId,
        })
        .from(audits)
        .where(eq(audits.id, auditId))
        .limit(1);
      return row ?? null;
    });
  }

  async list(scope: ScopeContext, query: ListAuditsQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        query.unitId ? eq(audits.unitId, query.unitId) : undefined,
        query.status ? eq(audits.status, query.status) : undefined,
        query.type ? eq(audits.auditType, query.type) : undefined,
        query.auditorId ? eq(audits.auditorUserId, query.auditorId) : undefined,
        query.from ? gte(audits.createdAt, new Date(query.from)) : undefined,
        query.to ? lte(audits.createdAt, new Date(query.to)) : undefined,
        // The live audit board: everything not yet finished or voided.
        query.active
          ? inArray(audits.status, ['ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'])
          : undefined,
        query.cursor ? sql`${audits.id} > ${query.cursor}` : undefined,
      ];

      return tx
        .select(auditColumns)
        .from(audits)
        .innerJoin(units, eq(units.id, audits.unitId))
        .innerJoin(users, eq(users.id, audits.auditorUserId))
        .where(this.scoped(scope, auditScopeColumns, ...filters))
        .orderBy(asc(audits.id))
        .limit(query.limit + 1);
    });
  }

  /**
   * Claims the single-writer lock (D7).
   *
   * One statement, so two devices racing cannot both win: the predicate and the write are
   * the same row lock. `null` means the claim failed, and the caller reads the row to say
   * whether that was because another device holds it or because the status was wrong.
   */
  async claimOwnership(
    scope: ScopeContext,
    auditId: string,
    deviceId: string,
    fromStatuses: readonly ('ASSIGNED' | 'READY' | 'PAUSED' | 'IN_PROGRESS')[],
  ): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(audits)
        .set({ owningDeviceId: deviceId, version: sql`${audits.version} + 1` })
        .where(
          and(
            eq(audits.id, auditId),
            inArray(audits.status, [...fromStatuses]),
            sql`(${audits.owningDeviceId} IS NULL OR ${audits.owningDeviceId} = ${deviceId}::uuid)`,
            this.scoped(scope, auditScopeColumns),
          ),
        )
        .returning({ id: audits.id });
      return row?.id ?? null;
    });
  }

  async updateAudit(
    scope: ScopeContext,
    auditId: string,
    patch: Partial<{
      status: 'ASSIGNED' | 'READY' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
      startedAt: Date | null;
      completedAt: Date | null;
      pausedAt: Date | null;
      pauseReason: string | null;
      resumeAuditZoneId: string | null;
      owningDeviceId: string | null;
      selfieEvidenceId: string | null;
      startLatitude: string | null;
      startLongitude: string | null;
      startAccuracyM: string | null;
      startLocationProvider: LocationProvider | null;
      startLocationIsMocked: boolean | null;
      startDistanceFromUnitM: string | null;
      locationSuspicious: boolean;
      clientUpdatedAt: Date;
    }>,
    /**
     * Runs on the same transaction, after the row moved — the domain event and, on
     * completion, the corrective actions (R-2). Skipped when nothing was updated.
     */
    afterWrite?: (tx: Transaction) => Promise<void>,
  ): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(audits)
        .set({ ...patch, version: sql`${audits.version} + 1` })
        .where(and(eq(audits.id, auditId), this.scoped(scope, auditScopeColumns)))
        .returning({ id: audits.id });
      if (row && afterWrite) {
        await afterWrite(tx as Transaction);
      }
      return row?.id ?? null;
    });
  }

  // ------------------------------------------------------------------- audit zones

  /**
   * The upsert of §8.6, with the D6 snapshots taken on **insert only**.
   *
   * `onConflictDoUpdate` deliberately omits every `*_snapshot` column: a later write of
   * the same audit Zone updates the remark and the cursor and leaves history alone. That
   * is what makes "editing a Zone afterwards does not alter the completed audit" a
   * property of the write path rather than of the client's good manners.
   */
  async upsertZone(
    scope: ScopeContext,
    input: {
      id: string;
      auditId: string;
      zoneId: string;
      sequenceNo: number;
      checklistVersionId: string | null;
      zoneRemark: string | null | undefined;
      resumeQuestionId: string | null | undefined;
      clientUpdatedAt: Date;
      snapshot: ZoneSnapshot;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .insert(auditZones)
        .values({
          id: input.id,
          auditId: input.auditId,
          zoneId: input.zoneId,
          sequenceNo: input.sequenceNo,
          checklistVersionId: input.checklistVersionId,
          zoneRemark: input.zoneRemark ?? null,
          resumeQuestionId: input.resumeQuestionId ?? null,
          clientUpdatedAt: input.clientUpdatedAt,
          ...input.snapshot,
        })
        .onConflictDoUpdate({
          target: auditZones.id,
          set: {
            zoneRemark: input.zoneRemark === undefined ? sql`${auditZones.zoneRemark}` : (input.zoneRemark ?? null),
            resumeQuestionId:
              input.resumeQuestionId === undefined
                ? sql`${auditZones.resumeQuestionId}`
                : (input.resumeQuestionId ?? null),
            sequenceNo: input.sequenceNo,
            clientUpdatedAt: input.clientUpdatedAt,
            version: sql`${auditZones.version} + 1`,
          },
        });
    });
  }

  async findZone(scope: ScopeContext, auditZoneId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          ...auditZoneColumns,
          auditStatus: audits.status,
          auditUnitId: audits.unitId,
          auditorUserId: audits.auditorUserId,
          owningDeviceId: audits.owningDeviceId,
          auditType: audits.auditType,
        })
        .from(auditZones)
        .innerJoin(audits, eq(audits.id, auditZones.auditId))
        .where(and(eq(auditZones.id, auditZoneId), this.scoped(scope, auditScopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  async listZones(scope: ScopeContext, auditId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select(auditZoneColumns)
        .from(auditZones)
        .innerJoin(audits, eq(audits.id, auditZones.auditId))
        .where(and(eq(auditZones.auditId, auditId), this.scoped(scope, auditScopeColumns)))
        .orderBy(asc(auditZones.sequenceNo));
    });
  }

  async updateZone(
    scope: ScopeContext,
    auditZoneId: string,
    patch: Partial<{
      status: 'DRAFT' | 'IN_PROGRESS' | 'COMPLETED';
      zoneRemark: string | null;
      resumeQuestionId: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
      clientUpdatedAt: Date;
    }>,
  ): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(auditZones)
        .set({ ...patch, version: sql`${auditZones.version} + 1` })
        .where(eq(auditZones.id, auditZoneId))
        .returning({ id: auditZones.id });
      return row?.id ?? null;
    });
  }

  /**
   * The Zone as the report will see it, for the D6 snapshot at creation time.
   *
   * Read under the actor's **`zone:read`** grant, not the one that admitted the audit
   * write: `own_audits` names an `ownerUserId` column `zone` does not have, and reusing it
   * would be a widening in the other direction anyway.
   */
  async readZoneSnapshot(scope: ScopeContext, zoneId: string) {
    const zoneScope = scopeFor(scope, 'zone:read');
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: zones.id,
          unitId: zones.unitId,
          code: zones.code,
          name: zones.name,
          description: zones.description,
          zoneLeaderId: zones.zoneLeaderId,
          // Through `app_zone_leader_name` rather than a join on `"user"`: PART 6 gives a
          // Consultant `own_record` on `user:read`, so `user_select` admits their own row
          // and no other — and a left join therefore yielded a silent NULL here, leaving
          // `zone_leader_name_snapshot` empty on every audit Zone a Consultant added. The
          // definer function returns the display name alone, and only inside the caller's
          // own Units (0008, DECISIONS.md R-12f).
          zoneLeaderName: sql<
            string | null
          >`app_zone_leader_name(${zones.unitId}, ${zones.zoneLeaderId})`,
          archivedAt: zones.archivedAt,
        })
        .from(zones)
        .where(and(eq(zones.id, zoneId), this.scoped(zoneScope, { unitId: zones.unitId })))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * R-19: the Zone an auditor named by number — found in the audit's Unit, or added to it.
   *
   * The scope is inside `app_ensure_zone_for_audit` (0014) rather than a predicate here:
   * the function answers only for an open audit the actor is conducting, in one of the
   * actor's Units, and returns no row otherwise. That is narrower than `zone:create`, which
   * this path deliberately does not grant.
   */
  async ensureZoneForAudit(
    scope: ScopeContext,
    input: {
      auditId: string;
      code: string;
      name: string;
      description: string | null;
      sortOrder: number;
    },
  ): Promise<{ zoneId: string; created: boolean } | null> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const result = await tx.execute(sql<{ ensured_zone_id: string; was_created: boolean }>`
        SELECT ensured_zone_id, was_created
        FROM app_ensure_zone_for_audit(
          ${input.auditId}::uuid, ${input.code}, ${input.name}, ${input.description}, ${input.sortOrder}::int
        )
      `);
      const row = result.rows[0] as { ensured_zone_id: string; was_created: boolean } | undefined;
      return row ? { zoneId: row.ensured_zone_id, created: row.was_created } : null;
    });
  }

  /**
   * The department label a report prints beside the Zone, snapshotted with it.
   *
   * Checklists are organization-wide reference data (D2), so the grant every role holds is
   * `organization` — which is still a resolver, still applied, and still built the same
   * way as every other predicate (AZ-1, AZ-4).
   */
  async readTemplateNameForVersion(scope: ScopeContext, versionId: string): Promise<string | null> {
    const readScope = scopeFor(scope, 'checklist_version:read');
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({ name: checklistTemplates.name })
        .from(checklistVersions)
        .innerJoin(checklistTemplates, eq(checklistTemplates.id, checklistVersions.templateId))
        .where(and(eq(checklistVersions.id, versionId), this.scoped(readScope, {})))
        .limit(1);
      return row?.name ?? null;
    });
  }

  // -------------------------------------------------------------- question responses

  /**
   * The response upsert. `UNIQUE(audit_zone_id, checklist_question_id)` is the idempotency
   * backbone: a retried sync lands on the same row, whatever id the client sent, so five
   * copies of one payload leave one row.
   */
  async upsertResponse(
    scope: ScopeContext,
    input: {
      id: string;
      auditZoneId: string;
      auditId: string;
      checklistQuestionId: string;
      section: SSection;
      globalOrder: number;
      value: ResponseValue;
      numericScore: number | null;
      remark: string | null | undefined;
      answeredAt: Date;
      clientUpdatedAt: Date;
    },
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .insert(questionResponses)
        .values({
          id: input.id,
          auditZoneId: input.auditZoneId,
          auditId: input.auditId,
          checklistQuestionId: input.checklistQuestionId,
          section: input.section,
          globalOrder: input.globalOrder,
          value: input.value,
          numericScore: input.numericScore,
          remark: input.remark ?? null,
          answeredAt: input.answeredAt,
          clientUpdatedAt: input.clientUpdatedAt,
        })
        .onConflictDoUpdate({
          target: [questionResponses.auditZoneId, questionResponses.checklistQuestionId],
          set: {
            value: input.value,
            numericScore: input.numericScore,
            remark: input.remark === undefined ? sql`${questionResponses.remark}` : (input.remark ?? null),
            answeredAt: input.answeredAt,
            clientUpdatedAt: input.clientUpdatedAt,
          },
        })
        .returning({ id: questionResponses.id });
      return row!.id;
    });
  }

  /**
   * Every response of one audit.
   *
   * Scoring reads `section` and `value` from here and hands them to `packages/domain`; the
   * stored `numeric_score` is deliberately **not** summed in SQL. The server recomputes
   * through the same function the device ran (D5), so the two agree because they are the
   * same code rather than because two implementations were written carefully.
   * `numeric_score` remains a denormalisation of the enum for analytics, not a second
   * source of truth for it.
   */
  async listResponses(scope: ScopeContext, auditId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({
          id: questionResponses.id,
          auditZoneId: questionResponses.auditZoneId,
          auditId: questionResponses.auditId,
          checklistQuestionId: questionResponses.checklistQuestionId,
          section: questionResponses.section,
          globalOrder: questionResponses.globalOrder,
          value: questionResponses.value,
          numericScore: questionResponses.numericScore,
          remark: questionResponses.remark,
          answeredAt: questionResponses.answeredAt,
          clientUpdatedAt: questionResponses.clientUpdatedAt,
          syncState: questionResponses.syncState,
        })
        .from(questionResponses)
        .innerJoin(audits, eq(audits.id, questionResponses.auditId))
        .where(and(eq(questionResponses.auditId, auditId), this.scoped(scope, auditScopeColumns)))
        .orderBy(asc(questionResponses.auditZoneId), asc(questionResponses.globalOrder));
    });
  }

  async findResponseById(scope: ScopeContext, responseId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: questionResponses.id,
          auditZoneId: questionResponses.auditZoneId,
          auditId: questionResponses.auditId,
          checklistQuestionId: questionResponses.checklistQuestionId,
          value: questionResponses.value,
          remark: questionResponses.remark,
        })
        .from(questionResponses)
        .innerJoin(audits, eq(audits.id, questionResponses.auditId))
        .where(and(eq(questionResponses.id, responseId), this.scoped(scope, auditScopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * The question, checked against the audit Zone's pinned version — invariant QR-2.
   *
   * The join is the check: a question from another version simply does not come back, so a
   * mid-audit republish cannot mix versions into one Zone.
   */
  async findQuestionInVersion(scope: ScopeContext, questionId: string, versionId: string) {
    const readScope = scopeFor(scope, 'checklist_version:read');
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: checklistQuestions.id,
          section: checklistQuestions.section,
          globalOrder: checklistQuestions.globalOrder,
          allowsNa: checklistQuestions.allowsNa,
        })
        .from(checklistQuestions)
        .where(
          this.scoped(
            readScope,
            {},
            eq(checklistQuestions.id, questionId),
            eq(checklistQuestions.versionId, versionId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }

  async countQuestionsInVersion(scope: ScopeContext, versionId: string): Promise<number> {
    const readScope = scopeFor(scope, 'checklist_version:read');
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(checklistQuestions)
        .where(this.scoped(readScope, {}, eq(checklistQuestions.versionId, versionId)));
      return row?.count ?? 0;
    });
  }

  // ------------------------------------------------------------------------ scoring

  /**
   * Writes the recomputed scores for one audit: the audit row, every Zone row, and the
   * materialised per-S rows. One transaction, because a half-written score is worse than
   * an unwritten one.
   */
  async writeScores(
    scope: ScopeContext,
    auditId: string,
    input: {
      audit: ScoreWrite;
      zones: Array<{
        auditZoneId: string;
        totals: ScoreWrite;
        sections: Array<{ section: SSection } & ScoreWrite>;
      }>;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await this.writeScoresOn(tx, auditId, input);
    });
  }

  /** The score write itself, so the ordinary path and the A-2 carve-out share one body. */
  private async writeScoresOn(
    tx: Transaction,
    auditId: string,
    input: {
      audit: ScoreWrite;
      zones: Array<{
        auditZoneId: string;
        totals: ScoreWrite;
        sections: Array<{ section: SSection } & ScoreWrite>;
      }>;
    },
  ): Promise<void> {
    {
      await tx
        .update(audits)
        .set({
          applicableQuestions: input.audit.applicableQuestions,
          naQuestions: input.audit.naQuestions,
          rawScore: input.audit.rawScore,
          maxScore: input.audit.maxScore,
          totalScore: input.audit.scorePercentage?.toFixed(3) ?? null,
          version: sql`${audits.version} + 1`,
        })
        .where(eq(audits.id, auditId));

      for (const zone of input.zones) {
        await tx
          .update(auditZones)
          .set({
            applicableQuestions: zone.totals.applicableQuestions,
            naQuestions: zone.totals.naQuestions,
            rawScore: zone.totals.rawScore,
            maxScore: zone.totals.maxScore,
            scorePercentage: zone.totals.scorePercentage?.toFixed(3) ?? null,
            version: sql`${auditZones.version} + 1`,
          })
          .where(eq(auditZones.id, zone.auditZoneId));

        for (const section of zone.sections) {
          await tx
            .insert(auditZoneSectionScores)
            .values({
              auditZoneId: zone.auditZoneId,
              section: section.section,
              applicableQuestions: section.applicableQuestions,
              naQuestions: section.naQuestions,
              rawScore: section.rawScore,
              maxScore: section.maxScore,
              scorePercentage: section.scorePercentage?.toFixed(3) ?? null,
            })
            .onConflictDoUpdate({
              target: [auditZoneSectionScores.auditZoneId, auditZoneSectionScores.section],
              set: {
                applicableQuestions: section.applicableQuestions,
                naQuestions: section.naQuestions,
                rawScore: section.rawScore,
                maxScore: section.maxScore,
                scorePercentage: section.scorePercentage?.toFixed(3) ?? null,
              },
            });
        }
      }
    }
  }

  /**
   * A-2's named carve-out, applied to one completed audit.
   *
   * Everything happens on one transaction: the flag that opens the trigger's carve-out,
   * the changes themselves, and the `AuditLog` entry recording them. That is the point —
   * an override cannot commit without its trail, because there is no ordering of these
   * statements in which one lands and the other does not.
   *
   * The flag alone is not a way in: `app_post_completion_override()` additionally requires
   * the actor to be a Super Admin, so a lower-privileged caller setting it changes nothing.
   */
  async applyPostCompletionOverride(
    scope: ScopeContext,
    input: {
      auditId: string;
      unitId: string;
      reopenAuditZoneId?: string;
      zoneRemark?: { auditZoneId: string; remark: string | null };
      responses: Array<{ responseId: string; value: ResponseValue; remark: string | null }>;
      before: unknown;
      after: unknown;
      requestId: string;
    },
  ): Promise<void> {
    await this.inOverrideTransaction(scope, async (tx) => {
      if (input.reopenAuditZoneId) {
        await tx
          .update(auditZones)
          .set({ status: 'IN_PROGRESS', completedAt: null })
          .where(eq(auditZones.id, input.reopenAuditZoneId));
      }

      if (input.zoneRemark) {
        await tx
          .update(auditZones)
          .set({ zoneRemark: input.zoneRemark.remark })
          .where(eq(auditZones.id, input.zoneRemark.auditZoneId));
      }

      for (const change of input.responses) {
        await tx
          .update(questionResponses)
          .set({
            value: change.value,
            numericScore: numericScoreFor(change.value),
            remark: change.remark,
          })
          .where(eq(questionResponses.id, change.responseId));
      }

      await tx.insert(auditLogs).values({
        actorUserId: scope.actor.userId,
        actorRole: scope.actor.role,
        actorLabel: scope.actor.userId,
        action: 'audit.changed_after_completion',
        resourceType: 'audit',
        resourceId: input.auditId,
        unitId: input.unitId,
        before: input.before,
        after: input.after,
        deviceId: scope.actor.deviceId,
        requestId: input.requestId,
      });
    });
  }

  /** Rewrites the scores of a frozen audit, inside the same carve-out. */
  async writeScoresUnderOverride(
    scope: ScopeContext,
    auditId: string,
    input: {
      audit: ScoreWrite;
      zones: Array<{
        auditZoneId: string;
        totals: ScoreWrite;
        sections: Array<{ section: SSection } & ScoreWrite>;
      }>;
    },
  ): Promise<void> {
    await this.inOverrideTransaction(scope, (tx) => this.writeScoresOn(tx, auditId, input));
  }

  private async inOverrideTransaction<T>(
    scope: ScopeContext,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx.execute(sql`SELECT set_config('app.post_completion_override', 'on', true)`);
      return work(tx);
    });
  }

  /** Whether every Zone of the audit is COMPLETED, and there is at least one (7.1). */
  async zoneCompletionState(
    scope: ScopeContext,
    auditId: string,
  ): Promise<{ total: number; completed: number }> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          total: sql<number>`COUNT(*)::int`,
          completed: sql<number>`COUNT(*) FILTER (WHERE ${auditZones.status} = 'COMPLETED')::int`,
        })
        .from(auditZones)
        .where(eq(auditZones.auditId, auditId));
      return { total: row?.total ?? 0, completed: row?.completed ?? 0 };
    });
  }

  /**
   * The Zones of this audit that hold no live photograph — §7.1's "walk-by zones each
   * have ≥1 photo", answered in one query rather than N.
   *
   * `NOT EXISTS` rather than a left join and a count: the question is a predicate per
   * Zone, and a Zone with a hundred photographs should cost the same as one with two.
   * Returns the snapshot codes so the refusal can name the Zone the auditor has to go
   * back to.
   */
  async zonesWithoutEvidence(scope: ScopeContext, auditId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({ id: auditZones.id, zoneCodeSnapshot: auditZones.zoneCodeSnapshot })
        .from(auditZones)
        .innerJoin(audits, eq(audits.id, auditZones.auditId))
        .where(
          and(
            eq(auditZones.auditId, auditId),
            this.scoped(scope, auditScopeColumns),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(evidence)
                .where(
                  and(eq(evidence.auditZoneId, auditZones.id), isNull(evidence.deletedAt)),
                ),
            ),
          ),
        )
        .orderBy(asc(auditZones.sequenceNo));
    });
  }

  /**
   * The Zone Leader §2.7 step 4 lets a walk-by auditor confirm or select, with their name.
   *
   * One read for both jobs: the membership is the validation (`ZONE_LEADER`, ACTIVE, this
   * Unit — the same four conditions `ZonesRepository.isZoneLeaderOfUnit` applies) and the
   * `full_name` is the D6 snapshot. Reading them separately would be two round trips for
   * one fact, and would leave a window where the membership held and the name did not.
   */
  async readZoneLeaderForUnit(scope: ScopeContext, unitId: string, userId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      // `app_zone_leader_name` *is* the validation as well as the lookup: it returns a
      // name only for an active `ZONE_LEADER` of that Unit, and only where the caller is
      // a member of it. Null therefore answers both questions the caller has — "may this
      // person be the Zone's leader" and "what do we print" — in one read, and without
      // reading a user record PART 6 does not grant (0008, DECISIONS.md R-12f).
      const [row] = await tx
        .select({
          fullName: sql<string | null>`app_zone_leader_name(${unitId}, ${userId})`,
        })
        .from(unitMemberships)
        .where(
          and(
            eq(unitMemberships.userId, userId),
            eq(unitMemberships.unitId, unitId),
            eq(unitMemberships.role, 'ZONE_LEADER'),
            eq(unitMemberships.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      return row?.fullName ? { id: userId, fullName: row.fullName } : null;
    });
  }

  /** The count of answers in one Zone, for the `all_questions_answered` guard. */
  async countResponsesInZone(scope: ScopeContext, auditZoneId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(questionResponses)
        .where(eq(questionResponses.auditZoneId, auditZoneId));
      return row?.count ?? 0;
    });
  }

  async listSectionScores(scope: ScopeContext, auditId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({
          auditZoneId: auditZoneSectionScores.auditZoneId,
          section: auditZoneSectionScores.section,
          applicableQuestions: auditZoneSectionScores.applicableQuestions,
          naQuestions: auditZoneSectionScores.naQuestions,
          rawScore: auditZoneSectionScores.rawScore,
          maxScore: auditZoneSectionScores.maxScore,
          scorePercentage: auditZoneSectionScores.scorePercentage,
        })
        .from(auditZoneSectionScores)
        .innerJoin(auditZones, eq(auditZones.id, auditZoneSectionScores.auditZoneId))
        .innerJoin(audits, eq(audits.id, auditZones.auditId))
        .where(and(eq(auditZones.auditId, auditId), this.scoped(scope, auditScopeColumns)))
        .orderBy(desc(auditZoneSectionScores.auditZoneId));
    });
  }

  /**
   * The Unit's geofence anchor (§12.9).
   *
   * Read under the actor's `unit:read` grant rather than the one that admitted the audit
   * write, for the same reason `readZoneSnapshot` does: reusing `own_audits` here would
   * ask `unit` for an `ownerUserId` column it does not have.
   */
  async readUnitGeofence(scope: ScopeContext, unitId: string) {
    const unitScope = scopeFor(scope, 'unit:read');
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          latitude: units.latitude,
          longitude: units.longitude,
          geofenceRadiusM: units.geofenceRadiusM,
        })
        .from(units)
        .where(and(eq(units.id, unitId), this.scoped(unitScope, { unitId: units.id })))
        .limit(1);
      return row ?? null;
    });
  }

  /** A device row that belongs to this actor and is not revoked. */
  async isOwnDevice(scope: ScopeContext, deviceId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const result = await tx.execute<{ ok: boolean }>(
        sql`SELECT true AS ok FROM device
            WHERE id = ${deviceId}::uuid AND user_id = ${scope.actor.userId}::uuid
              AND revoked_at IS NULL
            LIMIT 1`,
      );
      return result.rows.length > 0;
    });
  }

  private async readAudit(tx: Transaction, scope: ScopeContext, auditId: string) {
    const [row] = await tx
      .select(auditColumns)
      .from(audits)
      .innerJoin(units, eq(units.id, audits.unitId))
      .innerJoin(users, eq(users.id, audits.auditorUserId))
      .where(and(eq(audits.id, auditId), this.scoped(scope, auditScopeColumns)))
      .limit(1);
    return row ?? null;
  }
}

export type AuditRow = NonNullable<Awaited<ReturnType<AuditsRepository['findById']>>>;
export type AuditZoneRow = Awaited<ReturnType<AuditsRepository['listZones']>>[number];
export type AuditZoneWithAudit = NonNullable<Awaited<ReturnType<AuditsRepository['findZone']>>>;
export type QuestionResponseRow = Awaited<ReturnType<AuditsRepository['listResponses']>>[number];
