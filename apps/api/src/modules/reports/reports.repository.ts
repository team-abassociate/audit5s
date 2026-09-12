import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  audits,
  auditZones,
  auditZoneSectionScores,
  checklistQuestions,
  checklistVersions,
  correctiveActions,
  correctiveActionSubmissions,
  evidence,
  questionResponses,
  reportSnapshots,
  units,
  users,
  type Database,
  type Transaction,
} from '@audit5s/db';
import type { AuditStatus, ListReportsQuery, ReportKind, ReportPayload } from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

/**
 * Report snapshots, and the reads that freeze a payload (§5.8, §10.2).
 *
 * The freeze is **one read transaction** by design. A payload assembled over several
 * connections could catch a Zone mid-rename or an action mid-verification and produce a
 * document that describes a state the system was never in — which is the one failure a
 * frozen payload exists to rule out.
 *
 * Every read here is scoped on `report:generate`, which PART 6 grants to `SUPER_ADMIN`
 * alone at `organization`. The predicate is still constructed and still applied (AZ-4):
 * `organization` is the predicate `TRUE`, not a branch that skips the predicate.
 */
const snapshotScopeColumns = { unitId: reportSnapshots.unitId };

export type ReportSnapshotRow = typeof reportSnapshots.$inferSelect & { generatedByName: string };

export interface FrozenZoneSource {
  auditZoneId: string;
  auditId: string;
  auditType: (typeof audits.auditType)['_']['data'];
  zoneCode: string;
  zoneName: string;
  zoneDescription: string | null;
  zoneLeaderName: string | null;
  departmentName: string | null;
  checklistVersionNo: number | null;
  zoneRemark: string | null;
  completedAt: Date | null;
  auditStartedAt: Date | null;
  auditCompletedAt: Date | null;
  auditorName: string;
  auditorLoginId: string;
  applicableQuestions: number;
  naQuestions: number;
  rawScore: number;
  maxScore: number;
  scorePercentage: string | null;
  unitId: string;
}

@Injectable()
export class ReportsRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  /**
   * Runs `work` in one transaction with the actor context set.
   *
   * Exposed because the freeze is a sequence of reads that must see one instant, and
   * because `generate` inserts the snapshot and enqueues the render job on that same
   * transaction (R-2) — a job for a snapshot whose insert rolled back must not exist.
   */
  async inTransaction<T>(scope: ScopeContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return work(tx);
    });
  }

  // ---------------------------------------------------------------- snapshot records

  async findById(scope: ScopeContext, snapshotId: string): Promise<ReportSnapshotRow | null> {
    return this.inTransaction(scope, async (tx) => {
      const [row] = await this.selectSnapshots(tx)
        .where(and(eq(reportSnapshots.id, snapshotId), this.scoped(scope, snapshotScopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  /** §8.9's version history, newest first — the UI offers the latest and hides none. */
  async list(scope: ScopeContext, query: ListReportsQuery): Promise<ReportSnapshotRow[]> {
    return this.inTransaction(scope, async (tx) => {
      const filters: Array<SQL | undefined> = [
        query.auditId ? eq(reportSnapshots.auditId, query.auditId) : undefined,
        query.auditZoneId ? eq(reportSnapshots.auditZoneId, query.auditZoneId) : undefined,
        query.unitId ? eq(reportSnapshots.unitId, query.unitId) : undefined,
        query.kind ? eq(reportSnapshots.kind, query.kind) : undefined,
        query.cursor ? sql`${reportSnapshots.id} < ${query.cursor}` : undefined,
      ];
      return this.selectSnapshots(tx)
        .where(this.scoped(scope, snapshotScopeColumns, ...filters))
        .orderBy(desc(reportSnapshots.generatedAt), desc(reportSnapshots.id))
        .limit(query.limit + 1);
    });
  }

  /**
   * The next version for a target, and the row it supersedes.
   *
   * **The version sequence belongs to the target, not to the kind.** §10.5's chain is
   * explicit about it:
   *
   *     audit_zone X
   *      ├── ReportSnapshot v1  INITIAL_ZONE         [immutable]
   *      ├── ReportSnapshot v2  AFTER_EVIDENCE_ZONE  supersedes v1
   *      └── ReportSnapshot v3  AFTER_EVIDENCE_ZONE  supersedes v2
   *
   * An after-evidence report of a Zone is **v2 of that Zone's report**, not v1 of a
   * separate after-evidence series — which is what an external body reading "version 2"
   * expects, and what makes `supersedes_snapshot_id` a chain rather than two chains that
   * happen to share a Zone. §5.8's `UNIQUE(audit_zone_id, kind, version)` still holds; it
   * is simply wider than the sequence needs.
   *
   * Read inside the caller's transaction so the answer and the insert that uses it are one
   * act. That unique index is what makes it safe under a real race: two Super Admins
   * pressing Generate at the same moment produce one v2 and one 409, not two rows both
   * calling themselves v2.
   */
  async nextVersion(
    tx: Transaction,
    target: { auditZoneId: string | null; unitId: string; kind: ReportKind },
  ): Promise<{ version: number; supersedesSnapshotId: string | null }> {
    const [previous] = await tx
      .select({ id: reportSnapshots.id, version: reportSnapshots.version })
      .from(reportSnapshots)
      .where(
        target.auditZoneId
          ? eq(reportSnapshots.auditZoneId, target.auditZoneId)
          : and(
              eq(reportSnapshots.unitId, target.unitId),
              eq(reportSnapshots.kind, target.kind),
              isNull(reportSnapshots.auditZoneId),
            ),
      )
      .orderBy(desc(reportSnapshots.version))
      .limit(1);

    return {
      version: (previous?.version ?? 0) + 1,
      supersedesSnapshotId: previous?.id ?? null,
    };
  }

  async insertSnapshot(
    tx: Transaction,
    row: typeof reportSnapshots.$inferInsert,
  ): Promise<void> {
    await tx.insert(reportSnapshots).values(row);
  }

  /**
   * The worker's write-back. Guarded on the status it expects, so a job delivered twice
   * (pg-boss makes no at-most-once promise) cannot move a READY snapshot at all — RS-1's
   * trigger would refuse it anyway, and this turns that into a no-op rather than an error.
   */
  async markStatus(
    scope: ScopeContext,
    snapshotId: string,
    from: readonly ('QUEUED' | 'RENDERING')[],
    patch: Partial<typeof reportSnapshots.$inferInsert>,
  ): Promise<boolean> {
    return this.inTransaction(scope, async (tx) => {
      const updated = await tx
        .update(reportSnapshots)
        .set(patch)
        .where(and(eq(reportSnapshots.id, snapshotId), inArray(reportSnapshots.status, [...from])))
        .returning({ id: reportSnapshots.id });
      return updated.length > 0;
    });
  }

  // --------------------------------------------------------------- the freeze reads

  async readUnit(tx: Transaction, unitId: string) {
    const [row] = await tx
      .select({
        id: units.id,
        name: units.name,
        address: units.address,
        city: units.city,
        state: units.state,
      })
      .from(units)
      .where(eq(units.id, unitId))
      .limit(1);
    return row ?? null;
  }

  /**
   * The Zones of a report, with their snapshots and totals.
   *
   * Everything a page prints about a Zone comes from the `audit_zone` snapshot columns
   * (D6), never from `zone`: renaming a Zone in March must not alter the report issued in
   * January, and the only way to guarantee that is never to read the live row here.
   */
  async readZones(tx: Transaction, auditZoneIds: readonly string[]): Promise<FrozenZoneSource[]> {
    if (auditZoneIds.length === 0) return [];
    return tx
      .select({
        auditZoneId: auditZones.id,
        auditId: auditZones.auditId,
        auditType: audits.auditType,
        zoneCode: auditZones.zoneCodeSnapshot,
        zoneName: auditZones.zoneNameSnapshot,
        zoneDescription: auditZones.zoneDescriptionSnapshot,
        zoneLeaderName: auditZones.zoneLeaderNameSnapshot,
        departmentName: auditZones.checklistTemplateNameSnapshot,
        checklistVersionNo: checklistVersions.versionNumber,
        zoneRemark: auditZones.zoneRemark,
        completedAt: auditZones.completedAt,
        auditStartedAt: audits.startedAt,
        auditCompletedAt: audits.completedAt,
        auditorName: users.fullName,
        auditorLoginId: users.loginId,
        applicableQuestions: auditZones.applicableQuestions,
        naQuestions: auditZones.naQuestions,
        rawScore: auditZones.rawScore,
        maxScore: auditZones.maxScore,
        scorePercentage: auditZones.scorePercentage,
        unitId: audits.unitId,
      })
      .from(auditZones)
      .innerJoin(audits, eq(audits.id, auditZones.auditId))
      .innerJoin(users, eq(users.id, audits.auditorUserId))
      .leftJoin(checklistVersions, eq(checklistVersions.id, auditZones.checklistVersionId))
      .where(inArray(auditZones.id, [...auditZoneIds]))
      .orderBy(asc(auditZones.zoneCodeSnapshot), asc(auditZones.id));
  }

  async readSectionScores(tx: Transaction, auditZoneIds: readonly string[]) {
    if (auditZoneIds.length === 0) return [];
    return tx
      .select({
        auditZoneId: auditZoneSectionScores.auditZoneId,
        section: auditZoneSectionScores.section,
        applicable: auditZoneSectionScores.applicableQuestions,
        na: auditZoneSectionScores.naQuestions,
        raw: auditZoneSectionScores.rawScore,
        max: auditZoneSectionScores.maxScore,
        pct: auditZoneSectionScores.scorePercentage,
      })
      .from(auditZoneSectionScores)
      .where(inArray(auditZoneSectionScores.auditZoneId, [...auditZoneIds]));
  }

  /** All fifty, in section order, with the optional per-question remark §4.1 adds. */
  async readResponses(tx: Transaction, auditZoneIds: readonly string[]) {
    if (auditZoneIds.length === 0) return [];
    return tx
      .select({
        auditZoneId: questionResponses.auditZoneId,
        globalOrder: questionResponses.globalOrder,
        section: questionResponses.section,
        text: checklistQuestions.text,
        value: questionResponses.value,
        marks: questionResponses.numericScore,
        remark: questionResponses.remark,
      })
      .from(questionResponses)
      .innerJoin(checklistQuestions, eq(checklistQuestions.id, questionResponses.checklistQuestionId))
      .where(inArray(questionResponses.auditZoneId, [...auditZoneIds]))
      .orderBy(asc(questionResponses.auditZoneId), asc(questionResponses.globalOrder));
  }

  /**
   * The photographs of a Zone: GOOD and NONCONFORMITY, never NEUTRAL.
   *
   * Soft-deleted rows are excluded (E-4) — a photo withdrawn before completion is not part
   * of the record. Redacted ones are **not**: R-5's whole point is that the row survives
   * and the report says plainly that a photo was present and was removed.
   */
  async readPhotos(tx: Transaction, auditZoneIds: readonly string[]) {
    if (auditZoneIds.length === 0) return [];
    return tx
      .select({
        id: evidence.id,
        auditZoneId: evidence.auditZoneId,
        objectKey: evidence.objectKey,
        redactedAt: evidence.redactedAt,
        classification: evidence.classification,
        remark: evidence.remark,
        capturedAt: evidence.capturedAt,
        isSummaryFlagged: evidence.isSummaryFlagged,
        scoreAtCapture: evidence.scoreAtCapture,
        questionGlobalOrder: questionResponses.globalOrder,
        questionText: checklistQuestions.text,
        section: questionResponses.section,
      })
      .from(evidence)
      .leftJoin(questionResponses, eq(questionResponses.id, evidence.questionResponseId))
      .leftJoin(checklistQuestions, eq(checklistQuestions.id, questionResponses.checklistQuestionId))
      .where(
        and(
          inArray(evidence.auditZoneId, [...auditZoneIds]),
          inArray(evidence.classification, ['GOOD', 'NONCONFORMITY']),
          inArray(evidence.kind, ['QUESTION_EVIDENCE', 'WALK_BY_PHOTO']),
          isNull(evidence.deletedAt),
        ),
      )
      .orderBy(asc(evidence.auditZoneId), asc(questionResponses.globalOrder), asc(evidence.id));
  }

  /** §10.2's first validation: "audit COMPLETED or later". */
  async readAuditStatus(tx: Transaction, auditId: string): Promise<AuditStatus | null> {
    const [row] = await tx
      .select({ status: audits.status })
      .from(audits)
      .where(eq(audits.id, auditId))
      .limit(1);
    return row?.status ?? null;
  }

  /** The auditor's selfie for the AUDITOR VERIFICATION box (§4.1 item 4). */
  async readSelfieKey(tx: Transaction, auditId: string): Promise<string | null> {
    const [row] = await tx
      .select({ objectKey: evidence.objectKey, redactedAt: evidence.redactedAt })
      .from(evidence)
      .innerJoin(audits, eq(audits.selfieEvidenceId, evidence.id))
      .where(eq(audits.id, auditId))
      .limit(1);
    if (!row || row.redactedAt) return null;
    return row.objectKey;
  }

  /**
   * One corrective action per nonconformity, with the attempt that answers it.
   *
   * The attempt taken is the **latest** one, which is what the after-evidence report
   * prints: a reopened item shows the resubmission, and the earlier attempts stay in the
   * history where CA-1 keeps them rather than in the document.
   */
  async readCorrectiveActions(tx: Transaction, auditZoneIds: readonly string[]) {
    if (auditZoneIds.length === 0) return [];
    return tx
      .select({
        id: correctiveActions.id,
        evidenceId: correctiveActions.evidenceId,
        status: correctiveActions.status,
        dueAt: correctiveActions.dueAt,
        openedAt: correctiveActions.openedAt,
        resolvedAt: correctiveActions.resolvedAt,
        assignedZoneLeaderUserId: correctiveActions.assignedZoneLeaderUserId,
        unitId: correctiveActions.unitId,
        submissionOption: correctiveActionSubmissions.option,
        submittedByName: correctiveActionSubmissions.submittedByName,
        submittedAt: correctiveActionSubmissions.createdAt,
        description: correctiveActionSubmissions.description,
        explanation: correctiveActionSubmissions.explanation,
        afterEvidenceId: correctiveActionSubmissions.afterEvidenceId,
        afterObjectKey: evidence.objectKey,
        afterRedactedAt: evidence.redactedAt,
        afterCapturedAt: evidence.capturedAt,
      })
      .from(correctiveActions)
      .leftJoin(
        correctiveActionSubmissions,
        and(
          eq(correctiveActionSubmissions.correctiveActionId, correctiveActions.id),
          // The latest attempt, resolved in SQL rather than by reading them all back.
          eq(
            correctiveActionSubmissions.attemptNo,
            sql`(SELECT max(s.attempt_no) FROM corrective_action_submission s
                  WHERE s.corrective_action_id = ${correctiveActions.id})`,
          ),
        ),
      )
      .leftJoin(evidence, eq(evidence.id, correctiveActionSubmissions.afterEvidenceId))
      .where(inArray(correctiveActions.auditZoneId, [...auditZoneIds]))
      .orderBy(asc(correctiveActions.id));
  }

  /** The generating Super Admin's own name, for the payload's "generated by". */
  async readUserName(tx: Transaction, userId: string): Promise<string> {
    const [row] = await tx
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.fullName ?? 'Unknown';
  }

  /**
   * The `audit_zone` rows a summary's `selectedZoneIds` names.
   *
   * The selection is by **Zone**, not by audit-Zone: a Super Admin picks Zones on a
   * screen. Each Zone contributes its most recently completed audit-Zone, which is what
   * "the Zone's score" means anywhere else in this system.
   */
  async resolveLatestAuditZones(
    tx: Transaction,
    unitId: string,
    zoneIds: readonly string[],
  ): Promise<string[]> {
    if (zoneIds.length === 0) return [];
    const rows = await tx
      .select({ id: auditZones.id })
      .from(auditZones)
      .innerJoin(audits, eq(audits.id, auditZones.auditId))
      .where(
        and(
          eq(audits.unitId, unitId),
          inArray(auditZones.zoneId, [...zoneIds]),
          sql`${auditZones.completedAt} IS NOT NULL`,
          sql`${auditZones.id} = (
            SELECT az.id FROM audit_zone az
            INNER JOIN audit a ON a.id = az.audit_id
            WHERE az.zone_id = ${auditZones.zoneId}
              AND a.unit_id = ${unitId}
              AND az.completed_at IS NOT NULL
            ORDER BY az.completed_at DESC, az.id DESC
            LIMIT 1)`,
        ),
      )
      .orderBy(asc(auditZones.zoneCodeSnapshot), asc(auditZones.id));
    return rows.map((row) => row.id);
  }

  private selectSnapshots(tx: Transaction) {
    return tx
      .select({
        id: reportSnapshots.id,
        kind: reportSnapshots.kind,
        version: reportSnapshots.version,
        supersedesSnapshotId: reportSnapshots.supersedesSnapshotId,
        unitId: reportSnapshots.unitId,
        auditId: reportSnapshots.auditId,
        auditZoneId: reportSnapshots.auditZoneId,
        selectedZoneIds: reportSnapshots.selectedZoneIds,
        payload: reportSnapshots.payload,
        payloadSchemaVersion: reportSnapshots.payloadSchemaVersion,
        templateVersion: reportSnapshots.templateVersion,
        status: reportSnapshots.status,
        pdfObjectKey: reportSnapshots.pdfObjectKey,
        pdfChecksumSha256: reportSnapshots.pdfChecksumSha256,
        pageCount: reportSnapshots.pageCount,
        generatedByUserId: reportSnapshots.generatedByUserId,
        // Through 0010's narrow definer function, not a join: the Coordinator and Zone
        // Leader who read a report may not see the Super Admin who generated it, and an
        // inner join would hide the whole report from exactly the people it is for.
        generatedByName: sql<string>`COALESCE(app_report_author_name(${reportSnapshots.generatedByUserId}), 'Unknown')`,
        generatedAt: reportSnapshots.generatedAt,
        renderedAt: reportSnapshots.renderedAt,
        failedReason: reportSnapshots.failedReason,
        createdAt: reportSnapshots.createdAt,
        updatedAt: reportSnapshots.updatedAt,
      })
      .from(reportSnapshots);
  }
}

/** Type-only helper: the payload column is typed, so a bad freeze is a compile error. */
export type FrozenPayload = ReportPayload;
