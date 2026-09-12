import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type {
  AuditStatus,
  CorrectiveAction,
  CorrectiveActionDetail,
  CorrectiveActionSubmission,
  ListCorrectiveActionsQuery,
  Page,
  ReassignCorrectiveActionRequest,
  ReopenCorrectiveActionRequest,
  Role,
  SubmissionChannel,
  SubmitCorrectiveActionRequest,
  VerifyCorrectiveActionRequest,
} from '@audit5s/contracts';
import {
  assertTransition,
  grantFor,
  rollupAuditStatus,
  rollupPath,
  submissionTarget,
  type ScopeContext,
} from '@audit5s/domain';
import type { Transaction } from '@audit5s/db';
import { AppError } from '../../common/errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { scopeFor } from '../../common/auth/scope-for';
import { getRequestContext } from '../../common/observability/request-context';
import { isUniqueViolation } from '../../common/pg-errors';
import { CONFIG, type AppConfig } from '../../config/env';
import { DomainEvents } from '../../infrastructure/queue/domain-events';
import { asAppError } from '../audit-assignments/assignments.service';
import {
  CorrectiveActionsRepository,
  type CorrectiveActionRow,
  type CorrectiveActionWork,
  type SubmissionRow,
} from './corrective-actions.repository';

/**
 * Corrective actions (§2.8, §7.3, §8.8).
 *
 * The property everything here serves is §7.3's: **each action is an independent
 * aggregate.** No method touches more than one action, so a submission for item 3 cannot
 * read, lock or modify items 4 and 5 — which is what makes "3 today, 2 next week" safe by
 * construction rather than by care.
 *
 * Every status change goes through `assertTransition`, and the audit above the action
 * moves only along §7.1's edges (`rollupPath`), on the same transaction as the change that
 * caused it, with the event that tells people about it (R-2).
 */
@Injectable()
export class CorrectiveActionsService {
  constructor(
    private readonly repository: CorrectiveActionsRepository,
    private readonly events: DomainEvents,
    private readonly auditLog: AuditLogService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // -------------------------------------------------------------------------- reads

  async list(scope: ScopeContext, query: ListCorrectiveActionsQuery): Promise<Page<CorrectiveAction>> {
    const rows = await this.repository.list(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toCorrectiveAction), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  /** "Includes the full submission history" (§8.8), read under its own PART 6 cell. */
  async get(scope: ScopeContext, actionId: string): Promise<CorrectiveActionDetail> {
    const action = await this.mustFind(scope, actionId);
    const submissions = await this.repository.listSubmissions(
      scopeFor(scope, 'corrective_action_submission:read'),
      actionId,
    );
    return { ...toCorrectiveAction(action), submissions: submissions.map(toSubmission) };
  }

  /** §8.11's open actions, for a device. A Consultant reads actions but never answers one. */
  async listForCatalogue(scope: ScopeContext): Promise<CorrectiveAction[]> {
    if (scope.actor.role !== 'ZONE_LEADER') return [];
    const rows = await this.repository.listUnverified(scopeFor(scope, 'corrective_action:read'));
    return rows.map(toCorrectiveAction);
  }

  /**
   * The action, if this actor may answer it — PART 6's `assigned_actions` on `submit`.
   * Status is the caller's to judge: a retried upload may outlive the action's openness.
   */
  async findAnswerable(scope: ScopeContext, actionId: string): Promise<CorrectiveActionRow | null> {
    if (!grantFor(scope.actor.role, 'corrective_action:submit')) return null;
    return this.repository.findById(scopeFor(scope, 'corrective_action:submit'), actionId);
  }

  // ------------------------------------------------------------------- materialise

  /**
   * `COMPLETED → CORRECTIVE_ACTION_OPEN | CLOSED` (§7.1), on the completing transaction.
   *
   * One action per nonconformity photograph, then the audit rolls to where its actions
   * put it — CLOSED when it raised none. Returns the new actions' assignees so the
   * completion event can name them.
   */
  async materializeOnCompletion(
    tx: Transaction,
    scope: ScopeContext,
    auditId: string,
    completedAt: Date,
  ): Promise<{ opened: number; assigneeIds: string[]; auditStatus: AuditStatus }> {
    const unit = this.repository.within(tx, scope);
    const days = this.config.CORRECTIVE_ACTION_DUE_DAYS;
    const dueAt = days > 0 ? new Date(completedAt.getTime() + days * 86_400_000) : null;

    const created = await unit.materialize(auditId, dueAt);
    const auditStatus = await this.rollup(unit, auditId, null);

    return {
      opened: created.length,
      assigneeIds: [
        ...new Set(created.flatMap((action) => action.assignedZoneLeaderUserId ?? [])),
      ],
      auditStatus,
    };
  }

  // ------------------------------------------------------------------------- submit

  /**
   * `POST /corrective-actions/{id}/submissions` and the `submit` sync item (§8.8, §9.2).
   *
   * One attempt, on one action. Replaying the same submission id returns the attempt it
   * created rather than `attempt_no + 1` — the sync half of §8.2's guarantee; the HTTP
   * half is the `Idempotency-Key` the controller requires.
   */
  async submit(
    scope: ScopeContext,
    actionId: string,
    request: SubmitCorrectiveActionRequest,
    via: SubmissionChannel,
  ): Promise<CorrectiveActionSubmission> {
    // AZ-5: this is reachable from `/sync/batch`, whose own permission is `sync:push`, so
    // the service asks the question the route would have.
    if (!grantFor(scope.actor.role, 'corrective_action:submit')) {
      throw AppError.forbidden('FORBIDDEN', 'Only a Zone Leader answers a corrective action');
    }
    const submitScope = scopeFor(scope, 'corrective_action:submit');
    const action = await this.mustFind(submitScope, actionId);

    const photo =
      request.option === 'COMPLETED'
        ? await this.checkAfterPhoto(submitScope, action, request.afterEvidenceId, request.id)
        : null;

    // Option A takes its id from the photograph, which was keyed to it at capture (§5.6):
    // an HTTP client need not send one, and a device's is the same value anyway.
    const submissionId = request.id ?? photo?.correctiveActionSubmissionId ?? uuidv7();
    const target = submissionTarget(request.option);
    const context = getRequestContext();

    try {
      return await this.repository.inTransaction(submitScope, async (unit) => {
        const existing = await unit.findSubmission(submissionId);
        if (existing) {
          if (existing.correctiveActionId !== actionId) {
            throw AppError.conflict('CONFLICT', 'That submission id belongs to another action');
          }
          return toSubmission(existing);
        }

        const current = await unit.find(actionId);
        if (!current) throw AppError.notFound('No such corrective action');
        try {
          assertTransition('corrective_action', current.status, target, {
            role: scope.actor.role,
            satisfied: request.option === 'NOT_POSSIBLE' ? ['reason_given'] : [],
          });
        } catch (error) {
          throw asAppError(error);
        }

        const moved = await unit.moveAction(
          actionId,
          { status: current.status, version: current.version },
          { status: target, lastSubmittedAt: new Date() },
        );
        if (!moved) throw this.versionConflict();

        const attemptNo = await unit.insertSubmission({
          id: submissionId,
          correctiveActionId: actionId,
          option: request.option,
          submittedByName: request.option === 'COMPLETED' ? request.submittedByName : null,
          description: request.option === 'COMPLETED' ? request.description : null,
          explanation: request.option === 'NOT_POSSIBLE' ? request.explanation : null,
          afterEvidenceId: photo?.id ?? null,
          submittedVia: via,
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
        });

        await this.events.emit(unit.tx, {
          type: 'CORRECTIVE_ACTION_SUBMITTED',
          actorUserId: scope.actor.userId,
          unitId: current.unitId,
          resourceType: 'corrective_action',
          resourceId: actionId,
          data: { ...describe(current), option: request.option, attemptNo },
        });

        return toSubmission((await unit.findSubmission(submissionId))!);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'corrective_action_submission_attempt_key')) {
        throw this.versionConflict();
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------------- review

  /** `ACTION_SUBMITTED | NOT_POSSIBLE → VERIFIED` (§7.3). May close the audit. */
  async verify(
    scope: ScopeContext,
    actionId: string,
    request: VerifyCorrectiveActionRequest,
  ): Promise<CorrectiveActionDetail> {
    await this.review(scope, actionId, 'VERIFIED', request.comment ?? null, request.version);
    return this.get(scope, actionId);
  }

  /** `→ REOPENED`, reason required, every prior attempt kept (§7.3). */
  async reopen(
    scope: ScopeContext,
    actionId: string,
    request: ReopenCorrectiveActionRequest,
  ): Promise<CorrectiveActionDetail> {
    await this.review(scope, actionId, 'REOPENED', request.reason, request.version);
    return this.get(scope, actionId);
  }

  private async review(
    scope: ScopeContext,
    actionId: string,
    outcome: 'VERIFIED' | 'REOPENED',
    note: string | null,
    expectedVersion: number | undefined,
  ): Promise<void> {
    const before = await this.mustFind(scope, actionId);

    await this.repository.inTransaction(scope, async (unit) => {
      const current = await unit.find(actionId);
      if (!current) throw AppError.notFound('No such corrective action');
      if (expectedVersion !== undefined && expectedVersion !== current.version) {
        throw this.versionConflict();
      }
      try {
        assertTransition('corrective_action', current.status, outcome, {
          role: scope.actor.role,
          satisfied: note ? ['reason_given'] : [],
        });
      } catch (error) {
        throw asAppError(error);
      }

      // The version check comes first: of two reviewers acting at once, the second waits
      // on this row's lock and then matches nothing, before it can touch the attempt.
      const moved = await unit.moveAction(
        actionId,
        { status: current.status, version: current.version },
        outcome === 'VERIFIED'
          ? { status: 'VERIFIED', resolvedAt: new Date(), verifiedByUserId: scope.actor.userId }
          : {
              status: 'REOPENED',
              resolvedAt: null,
              verifiedByUserId: null,
              incrementReopenCount: true,
            },
      );
      if (!moved) throw this.versionConflict();

      // The attempt under review takes the outcome — once (CA-1). A VERIFIED action
      // reopened after the fact has none: its last attempt already carries VERIFIED, and
      // that stays true of it.
      const attempt = await unit.latestUnreviewed(actionId);
      if (attempt) {
        await unit.recordReview(attempt.id, outcome, note);
      }

      await this.rollup(unit, current.auditId, scope.actor.role);

      await this.events.emit(unit.tx, {
        type: outcome === 'VERIFIED' ? 'CORRECTIVE_ACTION_VERIFIED' : 'CORRECTIVE_ACTION_REOPENED',
        actorUserId: scope.actor.userId,
        unitId: current.unitId,
        resourceType: 'corrective_action',
        resourceId: actionId,
        userIds: [
          ...new Set([current.assignedZoneLeaderUserId, attempt?.submittedByUserId].filter(isString)),
        ],
        data: { ...describe(current), ...(outcome === 'REOPENED' ? { reason: note } : {}) },
      });
    });

    await this.auditLog.record({
      action: outcome === 'VERIFIED' ? 'corrective_action.verified' : 'corrective_action.reopened',
      resourceType: 'corrective_action',
      resourceId: actionId,
      unitId: before.unitId,
      before: { status: before.status },
      after: { status: outcome, ...(note ? { note } : {}) },
    });
  }

  /** `POST /corrective-actions/{id}/reassign` — the assignee pointer, not a grant (R-3b). */
  async reassign(
    scope: ScopeContext,
    actionId: string,
    request: ReassignCorrectiveActionRequest,
  ): Promise<CorrectiveActionDetail> {
    const before = await this.mustFind(scope, actionId);
    if (!(await this.repository.isZoneLeaderOfUnit(scope, before.unitId, request.zoneLeaderUserId))) {
      throw AppError.validation('The new assignee is not an active Zone Leader of this Unit', [
        { field: 'zoneLeaderUserId', message: 'No ACTIVE Zone Leader membership in this Unit' },
      ]);
    }
    if (before.assignedZoneLeaderUserId === request.zoneLeaderUserId) {
      return this.get(scope, actionId);
    }

    await this.repository.inTransaction(scope, async (unit) => {
      const moved = await unit.moveAction(
        actionId,
        { status: before.status, version: before.version },
        { assignedZoneLeaderUserId: request.zoneLeaderUserId },
      );
      if (!moved) throw this.versionConflict();
    });

    await this.auditLog.record({
      action: 'corrective_action.reassigned',
      resourceType: 'corrective_action',
      resourceId: actionId,
      unitId: before.unitId,
      before: { assignedZoneLeaderUserId: before.assignedZoneLeaderUserId },
      after: { assignedZoneLeaderUserId: request.zoneLeaderUserId },
    });

    return this.get(scope, actionId);
  }

  // ------------------------------------------------------------------------ helpers

  /**
   * Moves the audit to where its actions put it, one §7.1 edge at a time. The system
   * takes the system's edges; `CLOSED → PARTIALLY_CLOSED` is the Super Admin's own.
   */
  private async rollup(
    unit: CorrectiveActionWork,
    auditId: string,
    role: Role | null,
  ): Promise<AuditStatus> {
    const facts = await unit.rollupFacts(auditId);
    const target = rollupAuditStatus(facts.actions);
    const path = rollupPath(facts.auditStatus, target);
    if (!path) {
      throw AppError.internal(`Audit ${auditId} is ${facts.auditStatus}; it cannot roll to ${target}`);
    }
    for (const edge of path) {
      try {
        assertTransition('audit', edge.from, edge.to, { role: edge.actors.length === 0 ? null : role });
      } catch (error) {
        throw asAppError(error);
      }
      await unit.setAuditStatus(auditId, edge.to);
    }
    return target;
  }

  /** CA-2's application half, with the errors a person can act on. */
  private async checkAfterPhoto(
    scope: ScopeContext,
    action: CorrectiveActionRow,
    evidenceId: string,
    submissionId: string | undefined,
  ) {
    const photo = await this.repository.findAfterPhoto(scope, evidenceId);
    const invalid = (message: string) =>
      AppError.validation(message, [{ field: 'afterEvidenceId', message }]);

    if (!photo || photo.deletedAt) throw invalid('No such after-photo');
    if (photo.kind !== 'CORRECTIVE_AFTER' || photo.correctiveActionId !== action.id) {
      throw invalid('This photograph was not taken for this corrective action');
    }
    if (submissionId && photo.correctiveActionSubmissionId !== submissionId) {
      throw invalid('This photograph was taken for a different attempt');
    }
    if (!photo.isLiveCapture) {
      throw invalid('Option A requires a live after-photo (CA-2)');
    }
    if (photo.syncState !== 'SYNCED' || !photo.uploadedAt) {
      throw AppError.conflict(
        'EVIDENCE_NOT_UPLOADED',
        'The after-photo has not finished uploading. Commit it, then submit.',
      );
    }
    return photo;
  }

  private async mustFind(scope: ScopeContext, actionId: string): Promise<CorrectiveActionRow> {
    const row = await this.repository.findById(scope, actionId);
    if (!row) throw AppError.notFound('No such corrective action');
    return row;
  }

  private versionConflict(): AppError {
    return AppError.conflict(
      'VERSION_CONFLICT',
      'This corrective action changed while you were acting on it. Reload it and try again.',
    );
  }
}

function isString(value: string | null | undefined): value is string {
  return typeof value === 'string';
}

/** What an event needs to say which item it is, without a second read. */
function describe(action: CorrectiveActionRow) {
  return {
    auditId: action.auditId,
    zoneCode: action.zoneCode,
    zoneName: action.zoneName,
    questionNo: action.questionGlobalOrder,
  };
}

export function toCorrectiveAction(row: CorrectiveActionRow): CorrectiveAction {
  return {
    id: row.id,
    evidenceId: row.evidenceId,
    auditId: row.auditId,
    auditZoneId: row.auditZoneId,
    unitId: row.unitId,
    zoneId: row.zoneId,
    checklistQuestionId: row.checklistQuestionId,
    status: row.status,
    assignedZoneLeaderUserId: row.assignedZoneLeaderUserId,
    assignedZoneLeaderName: row.assignedZoneLeaderName,
    dueAt: row.dueAt?.toISOString() ?? null,
    openedAt: row.openedAt.toISOString(),
    lastSubmittedAt: row.lastSubmittedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    verifiedByUserId: row.verifiedByUserId,
    reopenCount: row.reopenCount,
    version: row.version,
    auditType: row.auditType,
    zoneCode: row.zoneCode,
    zoneName: row.zoneName,
    section: row.section,
    questionGlobalOrder: row.questionGlobalOrder,
    questionText: row.questionText,
    scoreAtCapture: row.scoreAtCapture,
    findingRemark: row.findingRemark,
    auditCompletedAt: row.auditCompletedAt?.toISOString() ?? null,
  };
}

export function toSubmission(row: SubmissionRow): CorrectiveActionSubmission {
  return {
    id: row.id,
    correctiveActionId: row.correctiveActionId,
    attemptNo: row.attemptNo,
    option: row.option,
    submittedByUserId: row.submittedByUserId,
    submittedByName: row.submittedByName,
    description: row.description,
    explanation: row.explanation,
    afterEvidenceId: row.afterEvidenceId,
    submittedVia: row.submittedVia as SubmissionChannel,
    reviewOutcome: row.reviewOutcome as CorrectiveActionSubmission['reviewOutcome'],
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewComment: row.reviewComment,
    createdAt: row.createdAt.toISOString(),
  };
}
