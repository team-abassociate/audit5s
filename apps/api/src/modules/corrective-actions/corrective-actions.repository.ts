import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql, type SQL, ne } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';
import {
  audits,
  auditZones,
  checklistQuestions,
  correctiveActions,
  correctiveActionSubmissions,
  evidence,
  units,
  zones,
  type Database,
  type Transaction,
} from '@audit5s/db';
import type {
  AuditStatus,
  CorrectiveActionStatus,
  CorrectiveActionSummaryQuery,
  CorrectiveOption,
  ListCorrectiveActionsQuery,
  Role,
  SubmissionChannel,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { SYSTEM_SCOPE } from '../../common/auth/system-scope';
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
  // Phase 7: `signed_token`'s single-item audience is this column (§6.2). Supplied here
  // rather than only where the public surface reads, so every query through this
  // repository narrows the same way when a signed link is the authority.
  correctiveActionId: correctiveActions.id,
};

const actionColumns = {
  id: correctiveActions.id,
  evidenceId: correctiveActions.evidenceId,
  auditId: correctiveActions.auditId,
  auditZoneId: correctiveActions.auditZoneId,
  unitId: correctiveActions.unitId,
  zoneId: correctiveActions.zoneId,
  checklistQuestionId: correctiveActions.checklistQuestionId,
  suggestion: correctiveActions.suggestion,
  suggestionNo: correctiveActions.suggestionNo,
  status: correctiveActions.status,
  assignedZoneLeaderUserId: correctiveActions.assignedZoneLeaderUserId,
  // The name alone, through 0008's narrow definer function — a Consultant may not read
  // the leader's user record, and does not need to.
  assignedZoneLeaderName: sql<string | null>`app_zone_leader_name(${correctiveActions.unitId}, ${correctiveActions.assignedZoneLeaderUserId})`,
  // D3: the Zone's leader now, account or typed name, as `zones.repository` reads it. A
  // correlated read rather than a join, so every query built on `selectActions` keeps its rows.
  zoneLeaderName: sql<string | null>`(SELECT COALESCE(app_zone_leader_name(z.unit_id, z.zone_leader_id), z.zone_leader_name)
    FROM zone z WHERE z.id = ${correctiveActions.zoneId})`,
  dueAt: correctiveActions.dueAt,
  openedAt: correctiveActions.openedAt,
  lastSubmittedAt: correctiveActions.lastSubmittedAt,
  resolvedAt: correctiveActions.resolvedAt,
  verifiedByUserId: correctiveActions.verifiedByUserId,
  // R-43: the approver's name, through 0041's narrow definer function — a Coordinator may
  // not read a Super Admin's user row. Null on a closure nobody has approved.
  verifiedByName: sql<string | null>`app_reviewer(${correctiveActions.verifiedByUserId}) ->> 'name'`,
  // R-39: who closed it, for the Coordinator's list. The latest attempt's name is the one
  // that settled a VERIFIED action — since R-23 an after-photo closes the item itself. A
  // correlated read of at most a handful of attempts, on `(corrective_action_id, …)`.
  closedByName: sql<string | null>`CASE WHEN ${correctiveActions.status} = 'VERIFIED' THEN (
    SELECT s.submitted_by_name FROM corrective_action_submission s
    WHERE s.corrective_action_id = ${correctiveActions.id}
    ORDER BY s.attempt_no DESC LIMIT 1) END`,
  reopenCount: correctiveActions.reopenCount,
  version: correctiveActions.version,
  auditType: audits.auditType,
  auditStatus: audits.status,
  auditorUserId: audits.auditorUserId,
  // Through 0010's narrow definer function, for the same reason the Zone Leader's name is:
  // a Zone Leader holding a signed link cannot read the Consultant's `user` row, and an
  // inner join would empty their page rather than the column.
  auditorName: sql<string | null>`app_audit_auditor_name(${correctiveActions.auditId})`,
  auditCompletedAt: audits.completedAt,
  zoneCode: auditZones.zoneCodeSnapshot,
  zoneName: auditZones.zoneNameSnapshot,
  section: checklistQuestions.section,
  questionGlobalOrder: checklistQuestions.globalOrder,
  questionText: checklistQuestions.text,
  scoreAtCapture: evidence.scoreAtCapture,
  findingRemark: evidence.remark,
};

/** Who to chase (D3): the leader it was reassigned to, else the Zone's. */
const chaseLeader = sql<string | null>`COALESCE(${actionColumns.assignedZoneLeaderName}, ${actionColumns.zoneLeaderName})`;
const awaitingAnswer = sql`${correctiveActions.status} IN ('OPEN','REOPENED')`;
const overdueNow = sql`${awaitingAnswer} AND ${correctiveActions.dueAt} < now()`;
const countWhere = (condition?: SQL) =>
  condition ? sql<number>`(count(*) FILTER (WHERE ${condition}))::int` : sql<number>`count(*)::int`;

/**
 * CA10: the list's order, as keys that are all ascending and never null, so one row
 * comparison against the cursor row's keys walks it — no page skips or repeats a row.
 * Groups come first, so a group's rows are contiguous; the id breaks every tie. Null
 * without a sort or group: the id order the field app has always had.
 */
function orderKeys(query: ListCorrectiveActionsQuery): SQL[] | null {
  if (!query.sort && !query.group) return null;
  const settled = sql`(${correctiveActions.status} NOT IN ('OPEN','REOPENED'))`;
  const due = sql`COALESCE(${correctiveActions.dueAt}, 'infinity'::timestamptz)`;
  const noLeader = sql`(${chaseLeader} IS NULL)`;
  const leader = sql`COALESCE(${chaseLeader}, '')`;
  const groupKeys =
    query.group === 'audit'
      ? // Newest audit first, as a negated epoch: every key ascends.
        [sql`${correctiveActions.unitId}`, sql`(-COALESCE(extract(epoch FROM ${audits.completedAt}), 0))`, sql`${correctiveActions.auditId}`]
      : query.group === 'leader'
        ? [
            sql`${correctiveActions.unitId}`,
            sql`COALESCE((SELECT z.code FROM zone z WHERE z.id = ${correctiveActions.zoneId}), '')`,
            sql`${correctiveActions.zoneId}`,
            noLeader,
            leader,
          ]
        : [];
  const sortKeys =
    query.sort === 'age'
      ? [sql`${correctiveActions.openedAt}`]
      : query.sort === 'leader'
        ? [noLeader, leader, settled, due]
        : [settled, due];
  return [...groupKeys, ...sortKeys, sql`${correctiveActions.id}`];
}

export type CorrectiveActionRow = NonNullable<
  Awaited<ReturnType<CorrectiveActionsRepository['findById'] >>
>;
export type SubmissionRow = typeof correctiveActionSubmissions.$inferSelect;
/** An attempt with its reviewer's name and role, as the detail read carries them (R-43). */
export type ReviewedSubmissionRow = SubmissionRow & {
  reviewedByName?: string | null;
  reviewedByRole?: Role | null;
};

export interface NewSubmission {
  id: string;
  correctiveActionId: string;
  option: CorrectiveOption;
  submittedByName: string | null;
  description: string | null;
  explanation: string | null;
  afterEvidenceId: string | null;
  submittedVia: SubmissionChannel;
  /** The signed link the attempt arrived on, when there was one (§10.4). */
  accessTokenId?: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

@Injectable()
export class CorrectiveActionsRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  // ------------------------------------------------------------------ overdue sweep

  /**
   * Claims this Unit's overdue, unannounced actions and marks them announced.
   *
   * One statement, because claiming and marking must not be separable: an `UPDATE …
   * RETURNING` cannot hand the same row to two sweeps, whereas a read followed by a write
   * can and eventually would — `worker-general` is one process today, and the moment it is
   * two, the duplicate is a Zone Leader told twice about the same finding.
   *
   * It writes before anyone is notified, which is the safe way round. If the emit then
   * fails, one overdue action goes unannounced and the dashboard still shows it; the other
   * order risks announcing the same thing every night, and a nightly reminder is one
   * people filter.
   */
  async claimOverdue(scope: ScopeContext, unitId: string, now: Date) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const claimed = await tx
        .update(correctiveActions)
        .set({ overdueNotifiedAt: now })
        .where(
          and(
            eq(correctiveActions.unitId, unitId),
            inArray(correctiveActions.status, ['OPEN', 'REOPENED']),
            isNull(correctiveActions.overdueNotifiedAt),
            sql`${correctiveActions.dueAt} IS NOT NULL AND ${correctiveActions.dueAt} < ${now}`,
            this.scoped(scope, scopeColumns),
          ),
        )
        .returning({ id: correctiveActions.id });

      if (claimed.length === 0) return [];

      // The Zone's code and name live on the audit's snapshot, not on the action, so the
      // rows a notification needs come from the same projection every other read uses —
      // in this transaction, so a claim without its message cannot be committed.
      return this.selectActions(tx).where(
        inArray(
          correctiveActions.id,
          claimed.map((row) => row.id),
        ),
      );
    });
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

  /**
   * Ordered by id — a UUIDv7 minted at materialisation, so open order — unless the query
   * names a sort or a group (CA10). Then the cursor is still a row's id, as everywhere
   * (§8.1), and the page starts after that row's position in the order.
   */
  async list(scope: ScopeContext, query: ListCorrectiveActionsQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const keys = orderKeys(query);
      if (!keys) {
        return this.selectActions(tx)
          .where(
            this.scoped(
              scope,
              scopeColumns,
              ...this.filters(query),
              query.cursor ? sql`${correctiveActions.id} > ${query.cursor}` : undefined,
            ),
          )
          .orderBy(asc(correctiveActions.id))
          .limit(query.limit + 1);
      }
      const row = sql.join(keys, sql`, `);
      const after = query.cursor
        ? sql`(${row}) > (${this.selectFrom(tx, Object.fromEntries(keys.map((key, i) => [`k${i}`, key])))
            .where(and(eq(correctiveActions.id, query.cursor), this.predicate(scope)))})`
        : undefined;
      return this.selectActions(tx)
        .where(this.scoped(scope, scopeColumns, ...this.filters(query), after))
        .orderBy(...keys)
        .limit(query.limit + 1);
    });
  }

  /** CA10: the counts over every row the list's filters match, not one page of them. */
  async summary(scope: ScopeContext, query: CorrectiveActionSummaryQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const where = this.scoped(scope, scopeColumns, ...this.filters(query));
      type Counts = { total: number; overdue: number };
      const [totals] = (await this.selectFrom(tx, {
        total: countWhere(),
        overdue: countWhere(overdueNow),
        dueWithinWeek: countWhere(
          sql`${awaitingAnswer} AND ${correctiveActions.dueAt} >= now() AND ${correctiveActions.dueAt} < now() + interval '7 days'`,
        ),
        openNeedsImprovement: countWhere(sql`${awaitingAnswer} AND ${evidence.scoreAtCapture} = 'SCORE_0'`),
      }).where(where)) as Array<Counts & { dueWithinWeek: number; openNeedsImprovement: number }>;
      const byStatus = (await this.selectFrom(tx, { status: correctiveActions.status, total: countWhere() })
        .where(where)
        .groupBy(correctiveActions.status)) as Array<{ status: CorrectiveActionStatus; total: number }>;
      const byAudit = (await this.selectFrom(tx, {
        unitId: correctiveActions.unitId,
        auditId: correctiveActions.auditId,
        total: countWhere(),
        overdue: countWhere(overdueNow),
      })
        .where(where)
        .groupBy(correctiveActions.unitId, correctiveActions.auditId)) as Array<Counts & { unitId: string; auditId: string }>;
      const byZoneLeader = (await this.selectFrom(tx, {
        unitId: correctiveActions.unitId,
        zoneId: correctiveActions.zoneId,
        zoneCode: sql`max(${auditZones.zoneCodeSnapshot})`,
        zoneName: sql`max(${auditZones.zoneNameSnapshot})`,
        leader: chaseLeader,
        total: countWhere(),
        overdue: countWhere(overdueNow),
      })
        .where(where)
        .groupBy(correctiveActions.unitId, correctiveActions.zoneId, chaseLeader)) as Array<
        Counts & { unitId: string; zoneId: string; zoneCode: string; zoneName: string; leader: string | null }
      >;
      return { totals: totals!, byStatus, byAudit, byZoneLeader };
    });
  }

  /** The list's filters, shared with its summary so the two always count the same rows. */
  private filters(query: CorrectiveActionSummaryQuery): Array<SQL | undefined> {
    return [
      query.unitId ? eq(correctiveActions.unitId, query.unitId) : undefined,
      query.zoneId ? eq(correctiveActions.zoneId, query.zoneId) : undefined,
      query.auditId ? eq(correctiveActions.auditId, query.auditId) : undefined,
      query.assignedTo ? eq(correctiveActions.assignedZoneLeaderUserId, query.assignedTo) : undefined,
      query.status ? eq(correctiveActions.status, query.status) : undefined,
      query.overdue ? overdueNow : undefined,
      query.awaitingReview ? inArray(correctiveActions.status, ['ACTION_SUBMITTED', 'NOT_POSSIBLE']) : undefined,
    ];
  }

  /**
   * §8.11's "open corrective actions": everything of the actor's scope still outstanding.
   *
   * Written as "not settled" rather than "not VERIFIED" since R-31. A withdrawn finding is
   * as done as a verified one — the mark it rested on was corrected — and shipping it to a
   * Zone Leader's device would put a job on their list that the server would refuse and
   * that nobody wanted doing.
   */
  async listUnverified(scope: ScopeContext) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return this.selectActions(tx)
        .where(
          this.scoped(
            scope,
            scopeColumns,
            notInArray(correctiveActions.status, ['VERIFIED', 'WITHDRAWN']),
          ),
        )
        .orderBy(asc(correctiveActions.id));
    });
  }

  /**
   * Completed audits carrying a finding that never got its corrective action.
   *
   * The shape `materialize` would have raised and did not: a live NONCONFORMITY photograph
   * of a Zone that was audited, with no action row, or an overall suggestion with none.
   * Reachable only through the defect fixed alongside this — completion raising actions
   * under the auditor's RLS, which hid the Zones from a Consultant whose grant on the
   * Unit had just lapsed. What it lists, `CorrectiveActionsService.raiseMissing` repairs.
   */
  async findAuditsWithUnraisedFindings(scope: ScopeContext) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({
          auditId: audits.id,
          unitId: audits.unitId,
          unitName: units.name,
          status: audits.status,
          completedAt: audits.completedAt,
          auditorName: sql<string | null>`app_audit_auditor_name(${audits.id})`,
          findings: sql<number>`(
            SELECT count(*)::int FROM evidence e
              JOIN audit_zone az ON az.id = e.audit_zone_id
             WHERE e.audit_id = ${audits.id}
               AND e.classification = 'NONCONFORMITY'
               AND e.kind IN ('QUESTION_EVIDENCE', 'WALK_BY_PHOTO')
               AND e.deleted_at IS NULL
               AND az.status <> 'WITHDRAWN'
               AND NOT EXISTS (SELECT 1 FROM corrective_action ca WHERE ca.evidence_id = e.id))`,
          suggestions: sql<number>`(
            SELECT count(*)::int FROM audit_zone az
              CROSS JOIN LATERAL unnest(az.overall_action_suggestions)
                         WITH ORDINALITY AS s(text, no)
             WHERE az.audit_id = ${audits.id}
               AND az.status <> 'WITHDRAWN'
               AND btrim(s.text) <> ''
               AND NOT EXISTS (SELECT 1 FROM corrective_action ca
                                WHERE ca.audit_zone_id = az.id AND ca.suggestion_no = s.no))`,
        })
        .from(audits)
        .innerJoin(units, eq(units.id, audits.unitId))
        .where(
          this.scoped(
            scope,
            { unitId: audits.unitId, ownerUserId: audits.auditorUserId },
            inArray(audits.status, ['COMPLETED', 'CORRECTIVE_ACTION_OPEN', 'PARTIALLY_CLOSED', 'CLOSED']),
          ),
        )
        .orderBy(asc(audits.completedAt))
        .then((rows) => rows.filter((row) => row.findings > 0 || row.suggestions > 0));
    });
  }

  /**
   * The two names the public page shows that the action row does not carry: the Unit's
   * name and the auditor's.
   *
   * Read under the same scope predicate as everything else — a signed link narrows this to
   * its own action's Unit, so it cannot be used to read a Unit name by id.
   */
  async findPublicContext(scope: ScopeContext, actionId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          unitName: units.name,
          // Through 0010's narrow definer function rather than a join: the reader is a
          // Zone Leader holding a link, who cannot see the Consultant's `user` row, and an
          // inner join would empty the page rather than the name.
          auditorName: sql<string | null>`app_audit_auditor_name(${correctiveActions.auditId})`,
        })
        .from(correctiveActions)
        .innerJoin(audits, eq(audits.id, correctiveActions.auditId))
        .innerJoin(units, eq(units.id, correctiveActions.unitId))
        .where(and(eq(correctiveActions.id, actionId), this.scoped(scope, scopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  async listSubmissions(scope: ScopeContext, actionId: string): Promise<ReviewedSubmissionRow[]> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({
          submission: correctiveActionSubmissions,
          // R-43: who reviewed it, by name and role, through 0041's definer function.
          reviewer: sql<{ name: string; role: Role } | null>`app_reviewer(${correctiveActionSubmissions.reviewedByUserId})`,
        })
        .from(correctiveActionSubmissions)
        .innerJoin(correctiveActions, eq(correctiveActions.id, correctiveActionSubmissions.correctiveActionId))
        .innerJoin(audits, eq(audits.id, correctiveActions.auditId))
        .where(
          this.scoped(scope, scopeColumns, eq(correctiveActionSubmissions.correctiveActionId, actionId)),
        )
        .orderBy(asc(correctiveActionSubmissions.attemptNo))
        .then((rows) =>
          rows.map((row) => ({
            ...row.submission,
            reviewedByName: row.reviewer?.name ?? null,
            reviewedByRole: row.reviewer?.role ?? null,
          })),
        );
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
      // Left, not inner: an overall action (R-38) answers a suggestion and has no photo.
      .leftJoin(evidence, eq(evidence.id, correctiveActions.evidenceId))
      .leftJoin(checklistQuestions, eq(checklistQuestions.id, correctiveActions.checklistQuestionId));
  }

  /**
   * @internal — the same joins with other columns: an order's keys, a summary's counts.
   * Untyped rows (drizzle loses the join types over a generic selection); callers name theirs.
   */
  private selectFrom(tx: Transaction | Database, columns: Record<string, SQL | AnyPgColumn>) {
    return tx
      .select(columns)
      .from(correctiveActions)
      .innerJoin(audits, eq(audits.id, correctiveActions.auditId))
      .innerJoin(auditZones, eq(auditZones.id, correctiveActions.auditZoneId))
      .leftJoin(evidence, eq(evidence.id, correctiveActions.evidenceId))
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
        ...(incrementReopenCount
          ? {
              reopenCount: sql`${correctiveActions.reopenCount} + 1`,
              // A reopened action gets a fresh chance to run late, so it gets a fresh
              // chance to be announced (0016). Cleared here, in the same statement as the
              // status change, so the two can never disagree about which it is.
              overdueNotifiedAt: null,
            }
          : {}),
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
      accessTokenId: input.accessTokenId ?? null,
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
  /**
   * R-31: the actions of this audit whose finding has gone.
   *
   * "Gone" is the photograph no longer being a live nonconformity — reclassified because
   * the mark was corrected, or soft-deleted. Read before the write rather than updated in
   * one statement so each row's current status can be put through `assertTransition`: this
   * is a state change like any other, and the one place in the system that may take it is
   * still required to ask the table whether it may.
   */
  async findWithdrawableActions(
    auditId: string,
  ): Promise<Array<{ id: string; status: CorrectiveActionStatus; assignedZoneLeaderUserId: string | null }>> {
    return this.tx
      .select({
        id: correctiveActions.id,
        status: correctiveActions.status,
        assignedZoneLeaderUserId: correctiveActions.assignedZoneLeaderUserId,
      })
      .from(correctiveActions)
      .innerJoin(evidence, eq(evidence.id, correctiveActions.evidenceId))
      .where(
        and(
          eq(correctiveActions.auditId, auditId),
          // VERIFIED is absent on purpose: somebody fixed that one and somebody checked it.
          // The mark being wrong afterwards does not unmake the work (R-31).
          inArray(correctiveActions.status, ['OPEN', 'REOPENED', 'ACTION_SUBMITTED', 'NOT_POSSIBLE']),
          sql`(${evidence.classification} <> 'NONCONFORMITY' OR ${evidence.deletedAt} IS NOT NULL)`,
        ),
      );
  }

  /**
   * R-33: every action of this audit that is still asking something of somebody.
   *
   * Wider than `findWithdrawableActions`, and deliberately: that one asks whether a
   * particular finding has gone, because a correction changes one mark. A restart puts the
   * whole audit back in play, so every unsettled action of it stops — the auditor is about
   * to re-decide the marks they all came from.
   *
   * VERIFIED and WITHDRAWN are absent for the same reason as there: both are settled, and
   * a verified action records work somebody actually did and checked (R-31).
   */
  async findRestartableActions(
    auditId: string,
  ): Promise<Array<{ id: string; status: CorrectiveActionStatus; assignedZoneLeaderUserId: string | null }>> {
    return this.tx
      .select({
        id: correctiveActions.id,
        status: correctiveActions.status,
        assignedZoneLeaderUserId: correctiveActions.assignedZoneLeaderUserId,
      })
      .from(correctiveActions)
      .where(
        and(
          eq(correctiveActions.auditId, auditId),
          inArray(correctiveActions.status, ['OPEN', 'REOPENED', 'ACTION_SUBMITTED', 'NOT_POSSIBLE']),
        ),
      );
  }

  /**
   * The mirror of `findWithdrawableActions`: withdrawn findings that are live again.
   *
   * A photograph whose action was withdrawn and which is a NONCONFORMITY once more — the
   * mark went back to a 0 after a restart, or a correction put it there. `materialize`
   * cannot raise these: it skips any evidence that already has an action row, and the
   * withdrawn one is still that row. So they are revived rather than re-created, which the
   * unique index on `evidence_id` requires anyway.
   */
  async findRevivableActions(
    auditId: string,
  ): Promise<Array<{ id: string; status: CorrectiveActionStatus; assignedZoneLeaderUserId: string | null }>> {
    const columns = {
      id: correctiveActions.id,
      status: correctiveActions.status,
      assignedZoneLeaderUserId: correctiveActions.assignedZoneLeaderUserId,
    };
    const findings = await this.tx
      .select(columns)
      .from(correctiveActions)
      .innerJoin(evidence, eq(evidence.id, correctiveActions.evidenceId))
      .where(
        and(
          eq(correctiveActions.auditId, auditId),
          eq(correctiveActions.status, 'WITHDRAWN'),
          eq(evidence.classification, 'NONCONFORMITY'),
          isNull(evidence.deletedAt),
        ),
      );

    /*
     * R-38: an overall suggestion withdrawn by a restart is live again when its Zone still
     * lists a suggestion at that place. Identity is the place, not the wording — the
     * auditor may have reworded it on the second look, and `refreshSuggestions` carries
     * the new wording onto the revived row. One the auditor deleted stays withdrawn.
     */
    const suggestions = await this.tx
      .select(columns)
      .from(correctiveActions)
      .innerJoin(auditZones, eq(auditZones.id, correctiveActions.auditZoneId))
      .where(
        and(
          eq(correctiveActions.auditId, auditId),
          eq(correctiveActions.status, 'WITHDRAWN'),
          sql`${correctiveActions.suggestionNo} IS NOT NULL`,
          ne(auditZones.status, 'WITHDRAWN'),
          sql`cardinality(${auditZones.overallActionSuggestions}) >= ${correctiveActions.suggestionNo}`,
        ),
      );

    return [...findings, ...suggestions];
  }

  /**
   * R-38: every unsettled overall action of this audit takes its Zone's current wording.
   *
   * Only reachable in practice after a restart, which is the one way the auditor edits a
   * suggestion after its action exists. A settled action keeps the words it was settled on.
   */
  async refreshSuggestions(auditId: string): Promise<void> {
    await this.tx.execute(sql`
      UPDATE corrective_action ca
         SET suggestion = az.overall_action_suggestions[ca.suggestion_no],
             version = ca.version + 1
        FROM audit_zone az
       WHERE az.id = ca.audit_zone_id
         AND ca.audit_id = ${auditId}::uuid
         AND ca.suggestion_no IS NOT NULL
         AND ca.status NOT IN ('VERIFIED', 'WITHDRAWN')
         AND cardinality(az.overall_action_suggestions) >= ca.suggestion_no
         AND btrim(az.overall_action_suggestions[ca.suggestion_no]) <> ''
         AND ca.suggestion IS DISTINCT FROM az.overall_action_suggestions[ca.suggestion_no]
    `);
  }

  /** Puts revived findings back in play: REOPENED, unsettled, with a fresh due date. */
  async revive(actionIds: readonly string[], dueAt: Date | null): Promise<void> {
    if (actionIds.length === 0) return;
    await this.tx
      .update(correctiveActions)
      .set({
        status: 'REOPENED',
        resolvedAt: null,
        dueAt,
        version: sql`${correctiveActions.version} + 1`,
      })
      .where(inArray(correctiveActions.id, [...actionIds]));
  }

  /** Withdraws the named actions. `resolved_at` is set: settled, though never fixed. */
  async withdraw(actionIds: readonly string[], at: Date): Promise<void> {
    if (actionIds.length === 0) return;
    await this.tx
      .update(correctiveActions)
      .set({
        status: 'WITHDRAWN',
        resolvedAt: at,
        version: sql`${correctiveActions.version} + 1`,
      })
      .where(inArray(correctiveActions.id, [...actionIds]));
  }

  /**
   * The findings of this audit that have appeared since it was completed, as rows the
   * caller can name in a notification.
   *
   * `materialize` returns only what it inserted, which is what this needs — but it returns
   * ids alone, and somebody has to be told *what* was raised.
   */
  async describeActions(actionIds: readonly string[]) {
    if (actionIds.length === 0) return [];
    return this.repository
      .selectActions(this.tx)
      .where(inArray(correctiveActions.id, [...actionIds]));
  }

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
   * Runs `work` as the system actor on this transaction, then restores the caller (R-23).
   *
   * For the audit roll-up only. Its edges have no human actor (§7.1), and the `audit` row's
   * RLS policy admits a Super Admin or the auditor — not a Zone Leader whose answer closed
   * the last finding. Every other statement on the transaction stays under the real actor.
   */
  async asSystem<T>(work: () => Promise<T>): Promise<T> {
    await setActorContext(this.tx, SYSTEM_SCOPE.actor.userId, SYSTEM_SCOPE.actor.role);
    try {
      return await work();
    } finally {
      await setActorContext(this.tx, this.scope.actor.userId, this.scope.actor.role);
    }
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
          // A Zone the auditor withdrew was not audited: its photos raise nothing.
          ne(auditZones.status, 'WITHDRAWN'),
        ),
      )
      .orderBy(asc(auditZones.sequenceNo), asc(evidence.id));

    const raised = findings.length === 0 ? [] : await this.materializeFindings(auditId, findings, dueAt);
    return [...raised, ...(await this.materializeSuggestions(auditId, dueAt))];
  }

  private async materializeFindings(
    auditId: string,
    findings: Array<{
      evidenceId: string;
      auditZoneId: string;
      unitId: string;
      zoneId: string;
      checklistQuestionId: string | null;
      leaderUserId: string | null;
    }>,
    dueAt: Date | null,
  ): Promise<Array<{ id: string; assignedZoneLeaderUserId: string | null }>> {
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

  /**
   * R-38: one action per overall suggestion the auditor wrote for a Zone.
   *
   * Routed and dated exactly as a finding is. Idempotent on `(audit_zone_id,
   * suggestion_no)` the way a finding is on `evidence_id`, so a replayed completion raises
   * nothing twice. A withdrawn Zone raises nothing, as its photographs raise nothing.
   */
  private async materializeSuggestions(
    auditId: string,
    dueAt: Date | null,
  ): Promise<Array<{ id: string; assignedZoneLeaderUserId: string | null }>> {
    const withSuggestions = await this.tx
      .select({
        auditZoneId: auditZones.id,
        unitId: audits.unitId,
        zoneId: auditZones.zoneId,
        leaderUserId: zones.zoneLeaderId,
        suggestions: auditZones.overallActionSuggestions,
      })
      .from(auditZones)
      .innerJoin(audits, eq(audits.id, auditZones.auditId))
      .innerJoin(zones, eq(zones.id, auditZones.zoneId))
      .where(
        and(
          eq(auditZones.auditId, auditId),
          ne(auditZones.status, 'WITHDRAWN'),
          sql`cardinality(${auditZones.overallActionSuggestions}) > 0`,
        ),
      )
      .orderBy(asc(auditZones.sequenceNo));

    const rows = withSuggestions.flatMap((zone) =>
      zone.suggestions.flatMap((text, index) =>
        text.trim() === ''
          ? []
          : [
              {
                id: uuidv7(),
                auditId,
                auditZoneId: zone.auditZoneId,
                unitId: zone.unitId,
                zoneId: zone.zoneId,
                suggestion: text.trim(),
                // The place in the auditor's list, which is the suggestion's identity.
                suggestionNo: index + 1,
                assignedZoneLeaderUserId: zone.leaderUserId,
                dueAt,
              },
            ],
      ),
    );
    if (rows.length === 0) return [];

    return this.tx
      .insert(correctiveActions)
      .values(rows)
      .onConflictDoNothing({
        target: [correctiveActions.auditZoneId, correctiveActions.suggestionNo],
        // Unqualified: the inference predicate names the partial index's own column.
        where: sql`suggestion_no IS NOT NULL`,
      })
      .returning({
        id: correctiveActions.id,
        assignedZoneLeaderUserId: correctiveActions.assignedZoneLeaderUserId,
      });
  }
}
