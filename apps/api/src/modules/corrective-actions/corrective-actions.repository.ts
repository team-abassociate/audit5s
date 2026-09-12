import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  audits,
  auditZones,
  checklistQuestions,
  correctiveActions,
  correctiveActionSubmissions,
  evidence,
  zones,
  type Database,
  type Transaction,
} from '@audit5s/db';
import type {
  AuditStatus,
  CorrectiveActionStatus,
  CorrectiveOption,
  ListCorrectiveActionsQuery,
  SubmissionChannel,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

/**
 * Corrective actions (§5.7, §8.8).
 *
 * Every read joins the audit, so all three resolvers PART 6 names for this resource have a
 * column to work on: `own_unit` the action's Unit, `own_audits` the audit's auditor (a
 * Consultant reads what their audit raised), `assigned_actions` the assignee or the Unit.
 */
const scopeColumns = {
  unitId: correctiveActions.unitId,
  ownerUserId: audits.auditorUserId,
  assignedUserId: correctiveActions.assignedZoneLeaderUserId,
};

const actionColumns = {
  id: correctiveActions.id,
  evidenceId: correctiveActions.evidenceId,
  auditId: correctiveActions.auditId,
  auditZoneId: correctiveActions.auditZoneId,
  unitId: correctiveActions.unitId,
  zoneId: correctiveActions.zoneId,
  checklistQuestionId: correctiveActions.checklistQuestionId,
  status: correctiveActions.status,
  assignedZoneLeaderUserId: correctiveActions.assignedZoneLeaderUserId,
  // The name alone, through 0008's narrow definer function — a Consultant may not read
  // the leader's user record, and does not need to.
  assignedZoneLeaderName: sql<string | null>`app_zone_leader_name(${correctiveActions.unitId}, ${correctiveActions.assignedZoneLeaderUserId})`,
  dueAt: correctiveActions.dueAt,
  openedAt: correctiveActions.openedAt,
  lastSubmittedAt: correctiveActions.lastSubmittedAt,
  resolvedAt: correctiveActions.resolvedAt,
  verifiedByUserId: correctiveActions.verifiedByUserId,
  reopenCount: correctiveActions.reopenCount,
  version: correctiveActions.version,
  auditType: audits.auditType,
  auditStatus: audits.status,
  auditCompletedAt: audits.completedAt,
  zoneCode: auditZones.zoneCodeSnapshot,
  zoneName: auditZones.zoneNameSnapshot,
  section: checklistQuestions.section,
  questionGlobalOrder: checklistQuestions.globalOrder,
  questionText: checklistQuestions.text,
  scoreAtCapture: evidence.scoreAtCapture,
  findingRemark: evidence.remark,
};

export type CorrectiveActionRow = NonNullable<
  Awaited<ReturnType<CorrectiveActionsRepository['findById'] >>
>;
export type SubmissionRow = typeof correctiveActionSubmissions.$inferSelect;

export interface NewSubmission {
  id: string;
  correctiveActionId: string;
  option: CorrectiveOption;
  submittedByName: string | null;
  description: string | null;
  explanation: string | null;
  afterEvidenceId: string | null;
  submittedVia: SubmissionChannel;
  ipAddress: string | null;
  userAgent: string | null;
}

@Injectable()
export class CorrectiveActionsRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  // -------------------------------------------------------------------------- reads

  async findById(scope: ScopeContext, actionId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await this.selectActions(tx)
        .where(and(eq(correctiveActions.id, actionId), this.scoped(scope, scopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  /** Ordered by id, which is a UUIDv7 minted at materialisation: id order is open order. */
  async list(scope: ScopeContext, query: ListCorrectiveActionsQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const filters: Array<SQL | undefined> = [
        query.unitId ? eq(correctiveActions.unitId, query.unitId) : undefined,
        query.zoneId ? eq(correctiveActions.zoneId, query.zoneId) : undefined,
        query.auditId ? eq(correctiveActions.auditId, query.auditId) : undefined,
        query.assignedTo ? eq(correctiveActions.assignedZoneLeaderUserId, query.assignedTo) : undefined,
        query.status ? eq(correctiveActions.status, query.status) : undefined,
        query.overdue
          ? sql`${correctiveActions.status} IN ('OPEN','REOPENED') AND ${correctiveActions.dueAt} < now()`
          : undefined,
        query.cursor ? sql`${correctiveActions.id} > ${query.cursor}` : undefined,
      ];
      return this.selectActions(tx)
        .where(this.scoped(scope, scopeColumns, ...filters))
        .orderBy(asc(correctiveActions.id))
        .limit(query.limit + 1);
    });
  }

  /** §8.11's "open corrective actions": everything of the actor's scope not yet VERIFIED. */
  async listUnverified(scope: ScopeContext) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return this.selectActions(tx)
        .where(this.scoped(scope, scopeColumns, ne(correctiveActions.status, 'VERIFIED')))
        .orderBy(asc(correctiveActions.id));
    });
  }

  async listSubmissions(scope: ScopeContext, actionId: string): Promise<SubmissionRow[]> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({ submission: correctiveActionSubmissions })
        .from(correctiveActionSubmissions)
        .innerJoin(correctiveActions, eq(correctiveActions.id, correctiveActionSubmissions.correctiveActionId))
        .innerJoin(audits, eq(audits.id, correctiveActions.auditId))
        .where(
          this.scoped(scope, scopeColumns, eq(correctiveActionSubmissions.correctiveActionId, actionId)),
        )
        .orderBy(asc(correctiveActionSubmissions.attemptNo))
        .then((rows) => rows.map((row) => row.submission));
    });
  }

  /**
   * An after-photo, read through RLS alone: a Zone Leader sees their Unit's evidence, and
   * the submission path checks the photo's link to the action itself.
   */
  async findAfterPhoto(scope: ScopeContext, evidenceId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: evidence.id,
          kind: evidence.kind,
          correctiveActionId: evidence.correctiveActionId,
          correctiveActionSubmissionId: evidence.correctiveActionSubmissionId,
          isLiveCapture: evidence.isLiveCapture,
          syncState: evidence.syncState,
          uploadedAt: evidence.uploadedAt,
          deletedAt: evidence.deletedAt,
        })
        .from(evidence)
        .where(eq(evidence.id, evidenceId))
        .limit(1);
      return row ?? null;
    });
  }

  /** Whether `userId` is an ACTIVE Zone Leader of the Unit, through 0008's definer. */
  async isZoneLeaderOfUnit(scope: ScopeContext, unitId: string, userId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const result = await tx.execute(
        sql`SELECT app_zone_leader_name(${unitId}::uuid, ${userId}::uuid) AS name`,
      );
      return Boolean((result.rows[0] as { name: string | null } | undefined)?.name);
    });
  }

  // -------------------------------------------------------------------------- writes

  /** One transaction under the actor's context; the unit of work is everything it may do. */
  async inTransaction<T>(
    scope: ScopeContext,
    work: (unit: CorrectiveActionWork) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return work(new CorrectiveActionWork(tx as Transaction, scope, this));
    });
  }

  /** The same unit of work on a transaction someone else opened — audit completion's. */
  within(tx: Transaction, scope: ScopeContext): CorrectiveActionWork {
    return new CorrectiveActionWork(tx, scope, this);
  }

  /** @internal — the unit of work's scoped read. */
  selectActions(tx: Transaction | Database) {
    return tx
      .select(actionColumns)
      .from(correctiveActions)
      .innerJoin(audits, eq(audits.id, correctiveActions.auditId))
      .innerJoin(auditZones, eq(auditZones.id, correctiveActions.auditZoneId))
      .innerJoin(evidence, eq(evidence.id, correctiveActions.evidenceId))
      .leftJoin(checklistQuestions, eq(checklistQuestions.id, correctiveActions.checklistQuestionId));
  }

  /** @internal */
  predicate(scope: ScopeContext): SQL {
    return this.scoped(scope, scopeColumns);
  }
}

/**
 * What one corrective-action transaction may do. The rules — which transitions, which
 * guards, what the audit rolls up to — are the service's; this is only the SQL, bound to
 * one transaction and one actor so the pieces commit or roll back together.
 */
export class CorrectiveActionWork {
  constructor(
    readonly tx: Transaction,
    private readonly scope: ScopeContext,
    private readonly repository: CorrectiveActionsRepository,
  ) {}

  async find(actionId: string): Promise<CorrectiveActionRow | null> {
    const [row] = await this.repository
      .selectActions(this.tx)
      .where(and(eq(correctiveActions.id, actionId), this.repository.predicate(this.scope)))
      .limit(1);
    return row ?? null;
  }

  async findSubmission(submissionId: string): Promise<SubmissionRow | null> {
    const [row] = await this.tx
      .select()
      .from(correctiveActionSubmissions)
      .where(eq(correctiveActionSubmissions.id, submissionId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Moves the action and bumps its version, **only** from `from` and only at `version`.
   *
   * The version is the optimistic lock of §15.8: of a Zone Leader and a Super Admin acting
   * at once, the second UPDATE waits on the first's row lock, then matches nothing. `false`
   * means someone else moved it first.
   */
  async moveAction(
    actionId: string,
    expected: { status: CorrectiveActionStatus; version: number },
    patch: Partial<{
      status: CorrectiveActionStatus;
      lastSubmittedAt: Date;
      resolvedAt: Date | null;
      verifiedByUserId: string | null;
      incrementReopenCount: true;
      assignedZoneLeaderUserId: string | null;
    }>,
  ): Promise<boolean> {
    const { incrementReopenCount, ...columns } = patch;
    const rows = await this.tx
      .update(correctiveActions)
      .set({
        ...columns,
        ...(incrementReopenCount ? { reopenCount: sql`${correctiveActions.reopenCount} + 1` } : {}),
        version: sql`${correctiveActions.version} + 1`,
      })
      .where(
        and(
          eq(correctiveActions.id, actionId),
          eq(correctiveActions.status, expected.status),
          eq(correctiveActions.version, expected.version),
        ),
      )
      .returning({ id: correctiveActions.id });
    return rows.length > 0;
  }

  /** CA-1: a new attempt is `max + 1`, and the unique pair refuses a racing duplicate. */
  async insertSubmission(input: NewSubmission): Promise<number> {
    const [{ next }] = (await this.tx
      .select({ next: sql<number>`COALESCE(MAX(${correctiveActionSubmissions.attemptNo}), 0) + 1` })
      .from(correctiveActionSubmissions)
      .where(eq(correctiveActionSubmissions.correctiveActionId, input.correctiveActionId))) as [
      { next: number },
    ];

    await this.tx.insert(correctiveActionSubmissions).values({
      id: input.id,
      correctiveActionId: input.correctiveActionId,
      attemptNo: Number(next),
      option: input.option,
      submittedByUserId: this.scope.actor.userId,
      // Option A's typed name; otherwise the account's own, read under own_record.
      submittedByName:
        input.submittedByName ??
        sql`(SELECT full_name FROM "user" WHERE id = ${this.scope.actor.userId}::uuid)`,
      description: input.description,
      explanation: input.explanation,
      afterEvidenceId: input.afterEvidenceId,
      submittedVia: input.submittedVia,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
    return Number(next);
  }

  /** The attempt awaiting review, if there is one — the only row a review may write. */
  async latestUnreviewed(actionId: string): Promise<SubmissionRow | null> {
    const [row] = await this.tx
      .select()
      .from(correctiveActionSubmissions)
      .where(
        and(
          eq(correctiveActionSubmissions.correctiveActionId, actionId),
          isNull(correctiveActionSubmissions.reviewOutcome),
        ),
      )
      .orderBy(desc(correctiveActionSubmissions.attemptNo))
      .limit(1);
    return row ?? null;
  }

  async recordReview(
    submissionId: string,
    outcome: 'VERIFIED' | 'REOPENED',
    comment: string | null,
  ): Promise<void> {
    await this.tx
      .update(correctiveActionSubmissions)
      .set({
        reviewOutcome: outcome,
        reviewedByUserId: this.scope.actor.userId,
        reviewedAt: new Date(),
        reviewComment: comment,
      })
      .where(eq(correctiveActionSubmissions.id, submissionId));
  }

  /** The audit's status and every one of its actions' — all the rollup needs. */
  async rollupFacts(auditId: string): Promise<{ auditStatus: AuditStatus; actions: CorrectiveActionStatus[] }> {
    const [audit] = await this.tx
      .select({ status: audits.status })
      .from(audits)
      .where(eq(audits.id, auditId))
      .limit(1);
    const actions = await this.tx
      .select({ status: correctiveActions.status })
      .from(correctiveActions)
      .where(eq(correctiveActions.auditId, auditId));
    return { auditStatus: audit!.status, actions: actions.map((action) => action.status) };
  }

  /** A status move on a completed audit — one of the columns A-2 leaves writable. */
  async setAuditStatus(auditId: string, status: AuditStatus): Promise<void> {
    await this.tx
      .update(audits)
      .set({
        status,
        closedAt: status === 'CLOSED' ? new Date() : null,
        version: sql`${audits.version} + 1`,
      })
      .where(eq(audits.id, auditId));
  }

  /**
   * One action per nonconformity photograph (§2.8), on the completing transaction.
   *
   * Photos soft-deleted before completion raised nothing (E-4). The assignee is the Zone's
   * **live** leader pointer (§5.7: "routed from `zone.zone_leader_id` at materialization"),
   * and `ON CONFLICT DO NOTHING` on `UNIQUE(evidence_id)` makes a replayed completion
   * raise nothing twice.
   */
  async materialize(auditId: string, dueAt: Date | null): Promise<Array<{ id: string; assignedZoneLeaderUserId: string | null }>> {
    const findings = await this.tx
      .select({
        evidenceId: evidence.id,
        auditZoneId: auditZones.id,
        unitId: audits.unitId,
        zoneId: auditZones.zoneId,
        checklistQuestionId: sql<string | null>`(SELECT qr.checklist_question_id FROM question_response qr WHERE qr.id = ${evidence.questionResponseId})`,
        leaderUserId: zones.zoneLeaderId,
      })
      .from(evidence)
      .innerJoin(audits, eq(audits.id, evidence.auditId))
      .innerJoin(auditZones, eq(auditZones.id, evidence.auditZoneId))
      .innerJoin(zones, eq(zones.id, auditZones.zoneId))
      .where(
        and(
          eq(evidence.auditId, auditId),
          eq(evidence.classification, 'NONCONFORMITY'),
          inArray(evidence.kind, ['QUESTION_EVIDENCE', 'WALK_BY_PHOTO']),
          isNull(evidence.deletedAt),
        ),
      )
      .orderBy(asc(auditZones.sequenceNo), asc(evidence.id));

    if (findings.length === 0) return [];

    return this.tx
      .insert(correctiveActions)
      .values(
        findings.map((finding) => ({
          id: uuidv7(),
          evidenceId: finding.evidenceId,
          auditId,
          auditZoneId: finding.auditZoneId,
          unitId: finding.unitId,
          zoneId: finding.zoneId,
          checklistQuestionId: finding.checklistQuestionId,
          assignedZoneLeaderUserId: finding.leaderUserId,
          dueAt,
        })),
      )
      .onConflictDoNothing({ target: correctiveActions.evidenceId })
      .returning({
        id: correctiveActions.id,
        assignedZoneLeaderUserId: correctiveActions.assignedZoneLeaderUserId,
      });
  }
}
