import { Injectable, Logger } from '@nestjs/common';
import type {
  Audit,
  AuditDetail,
  AuditScoreSummary,
  AuditStatus,
  AuditZone,
  CancelAuditRequest,
  CompleteAuditRequest,
  CreateAuditRequest,
  ListAuditsQuery,
  Page,
  PauseAuditRequest,
  PostCompletionOverrideRequest,
  QuestionResponse,
  ReleaseDeviceRequest,
  ResumeAuditRequest,
  StartAuditRequest,
  ZoneLocksResponse,
} from '@audit5s/contracts';
import {
  assertTransition,
  assessLocation,
  auditTypeRequiresZonePhoto,
  auditTypeUsesChecklist,
  isAuditCompleted,
  isScoredAuditType,
  type LocationAssessment,
  type ScopeContext,
  type TransitionGuard,
} from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { scopeFor } from '../../common/auth/scope-for';
import type { Transaction } from '@audit5s/db';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { DomainEvents } from '../../infrastructure/queue/domain-events';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import type { AnalyticsRefreshJob } from '../analytics/analytics-rollup.worker';
import { CorrectiveActionsService } from '../corrective-actions/corrective-actions.service';
import { EvidenceService } from '../evidence/evidence.service';
import { getRequestContext } from '../../common/observability/request-context';
import { UnitsRepository } from '../units/units.repository';
import { AssignmentsRepository } from '../audit-assignments/assignments.repository';
import { asAppError } from '../audit-assignments/assignments.service';
import {
  AuditsRepository,
  type AuditRow,
  type AuditZoneRow,
  type QuestionResponseRow,
} from './audits.repository';
import { ScoringService, toScoreSummary, toSection, toTotals } from './scoring.service';
import { SelfieRequirement } from './selfie-requirement';

/**
 * The audit lifecycle (§7.1, §8.6).
 *
 * Every status change in this file goes through `assertTransition` — there is no `SET
 * status =` that has not first been judged by the table in `packages/domain`. Guards the
 * pure layer cannot evaluate are resolved here and handed in by name, so the reason a
 * refusal happened survives into the 409 rather than being flattened to "conflict".
 *
 * The endpoints §8.6 marks idempotent are idempotent by *detecting the no-op before
 * asking*: a second `complete` on a COMPLETED audit returns the same body, and never
 * consults the state machine, because `COMPLETED → COMPLETED` is not an edge and should
 * not become one.
 */
@Injectable()
export class AuditsService {
  private readonly logger = new Logger(AuditsService.name);

  constructor(
    private readonly repository: AuditsRepository,
    private readonly assignments: AssignmentsRepository,
    private readonly units: UnitsRepository,
    private readonly scoring: ScoringService,
    private readonly selfies: SelfieRequirement,
    private readonly auditLog: AuditLogService,
    private readonly events: DomainEvents,
    private readonly correctiveActions: CorrectiveActionsService,
    private readonly queue: QueueService,
    // R-31: a corrected mark reclassifies the photograph filed under it, on the override's
    // own transaction. `AuditZonesService` already holds this for E-2 before completion.
    private readonly evidence: EvidenceService,
  ) {}

  // ------------------------------------------------------------------------ create

  async create(scope: ScopeContext, request: CreateAuditRequest): Promise<Audit> {
    // §8.6 (a): the same client id returns the existing audit rather than a duplicate or
    // an unreadable primary-key violation.
    const existing = await this.repository.findForCreateIdempotency(scope, request.id);
    if (existing) {
      if (existing.auditorUserId !== scope.actor.userId) {
        throw AppError.conflict(
          'CONFLICT',
          'An audit already exists with this id and belongs to another auditor',
        );
      }
      return this.get(scope, request.id);
    }

    // Read under the actor's **`unit:read`** grant, not the one that admitted this call.
    // The two differ: a `POST /audits` arrives under `audit:create_*` (`assigned_units`),
    // and the same service reached through `/sync/batch` arrives under `sync:push`
    // (`own_audits`) — which asks `unit` for an `ownerUserId` column it does not have.
    // `scopeFor` re-derives the resolver from PART 6 for the resource actually being read,
    // which is the rule `readZoneSnapshot` and the sync catalogue already follow.
    const unit = await this.units.findById(scopeFor(scope, 'unit:read'), request.unitId);
    if (!unit) {
      // AZ-3: a Unit outside scope reads as absent, so ids cannot be probed.
      throw AppError.notFound('No such Unit');
    }

    // §2.7: "No questionnaire, no score." §5.5 says the same in schema terms —
    // `checklist_version_id` is "Null for `WALK_BY`" — and 0008 makes it a CHECK. Refused
    // here as well, with a message, because a constraint violation reaches a device as an
    // opaque 500 and this is a mistake a client can correct.
    if (!auditTypeUsesChecklist(request.auditType) && request.checklistVersionId) {
      throw AppError.validation('A walk-by audit has no questionnaire', [
        {
          field: 'checklistVersionId',
          message: 'A WALK_BY audit pins no checklist version (§2.7, §5.5)',
        },
      ]);
    }

    const assignmentId = await this.resolveAssignment(scope, request);
    const deviceId = this.requireDevice(scope, request.deviceId);

    await this.requireOwnDevice(scope, deviceId);

    // §7.1: an auditor who has already captured their selfie is READY; otherwise the
    // audit waits at ASSIGNED until one arrives.
    //
    // Phase 3 made this conditional on there being an assignment, because `evidence` did
    // not exist and a self-initiated CROSS_5S or WALK_BY would otherwise have been stuck
    // at a guard nothing could satisfy. Now that a selfie is a real row, the condition is
    // the selfie alone — §2.6 and §2.7 both open with one, and an audit created straight
    // into READY would be an audit that never passes the guard at all.
    const selfieHeld = await this.selfies.isSatisfied(scope, request.selfieEvidenceId ?? null);
    const status: 'ASSIGNED' | 'READY' = selfieHeld ? 'READY' : 'ASSIGNED';

    // §12.9: the distance is computed here, from the Unit's stored coordinates, and the
    // flag with it. Neither blocks anything — `assessLocation` returns no verdict a caller
    // could act on, deliberately — but both are recorded so a reviewer can see them.
    const assessment = await this.assessStartLocation(scope, request.unitId, request.location);

    await this.repository.create(scope, {
      id: request.id,
      assignmentId,
      unitId: request.unitId,
      auditType: request.auditType,
      status,
      auditorUserId: scope.actor.userId,
      checklistVersionId: request.checklistVersionId ?? null,
      selfieEvidenceId: request.selfieEvidenceId ?? null,
      owningDeviceId: deviceId,
      clientCreatedAt: request.clientCreatedAt ? new Date(request.clientCreatedAt) : new Date(),
      locationAssessment: { distanceM: assessment.distanceM, suspicious: assessment.suspicious },
      location: request.location
        ? {
            latitude: request.location.latitude,
            longitude: request.location.longitude,
            accuracyM: request.location.accuracyM ?? null,
            provider: request.location.provider,
            isMocked: request.location.isMocked,
          }
        : null,
    });

    return this.get(scope, request.id);
  }

  // -------------------------------------------------------------------------- reads

  async list(scope: ScopeContext, query: ListAuditsQuery): Promise<Page<Audit>> {
    const rows = await this.repository.list(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toAudit), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  async get(scope: ScopeContext, auditId: string): Promise<Audit> {
    return toAudit(await this.mustFind(scope, auditId));
  }

  async detail(scope: ScopeContext, auditId: string): Promise<AuditDetail> {
    const audit = await this.mustFind(scope, auditId);
    const zones = await this.repository.listZones(scope, auditId);
    const responses = await this.repository.listResponses(scope, auditId);
    const sections = await this.repository.listSectionScores(scope, auditId);

    return {
      ...toAudit(audit),
      zones: zones.map((zone) => ({
        ...toAuditZone(
          zone,
          sections.filter((section) => section.auditZoneId === zone.id),
        ),
        responses: responses
          .filter((response) => response.auditZoneId === zone.id)
          .map(toQuestionResponse),
      })),
    };
  }

  /**
   * `GET /audits/{id}/summary` (§8.6) — the Consultant's read model, and explicitly **not**
   * an official report (N6). Recomputed from the responses, not read from the cache.
   */
  async summary(scope: ScopeContext, auditId: string): Promise<AuditScoreSummary> {
    const audit = await this.mustFind(scope, auditId);
    const zones = await this.repository.listZones(scope, auditId);
    const { audit: auditBreakdown, zones: zoneBreakdowns } = await this.scoring.summarise(
      scope,
      auditId,
    );

    return {
      scored: isScoredAuditType(audit.auditType),
      audit: toScoreSummary(audit.id, null, auditBreakdown),
      zones: zones.map((zone) => {
        const breakdown = zoneBreakdowns.get(zone.id)!;
        return {
          ...toScoreSummary(audit.id, zone.id, breakdown),
          zoneCode: zone.zoneCodeSnapshot,
          zoneName: zone.zoneNameSnapshot,
          checklistTemplateName: zone.checklistTemplateNameSnapshot,
          status: zone.status,
        };
      }),
    };
  }

  /**
   * `GET /audits/{id}/zone-locks` (R-29) — the Zones of this audit's Unit that another
   * open audit is holding, so the picker can grey them out and say who has them.
   *
   * A courtesy, not the control. The device is offline by design: it may have started this
   * audit before the other one existed, and it will have to hear the refusal from the sync
   * batch either way. What this prevents is the *avoidable* case — an auditor who is
   * online, standing in a plant, about to spend forty minutes re-auditing a Zone their
   * colleague is already in.
   */
  async zoneLocks(scope: ScopeContext, auditId: string): Promise<ZoneLocksResponse> {
    const audit = await this.mustFind(scope, auditId);
    return {
      auditId,
      unitId: audit.unitId,
      locks: await this.repository.listZoneLocks(scope, auditId),
    };
  }

  // ---------------------------------------------------------------------- lifecycle

  /**
   * `POST /audits/{id}/start` — claims the single-writer lock and moves to IN_PROGRESS.
   *
   * An audit sitting at ASSIGNED passes through READY on the way, because that is the edge
   * §7.1 draws and the selfie guard belongs to it. Both moves are judged; neither is
   * assumed.
   */
  async start(scope: ScopeContext, auditId: string, request: StartAuditRequest): Promise<Audit> {
    const audit = await this.mustFind(scope, auditId);
    const deviceId = this.requireDevice(scope, request.deviceId);

    // Idempotent: the owning device restarting a running audit gets the audit back.
    if (audit.status === 'IN_PROGRESS' && audit.owningDeviceId === deviceId) {
      return toAudit(audit);
    }

    // An IN_PROGRESS audit whose lock is **free** is claimable. That is the whole point of
    // the force-release of §9.5 Layer 1: a Super Admin clears the lock on a lost phone so
    // a replacement can pick the audit up. Refusing here because the status is already
    // IN_PROGRESS would make the release a no-op and leave the audit stranded — which is
    // the situation it exists to resolve.
    if (audit.status === 'IN_PROGRESS' && audit.owningDeviceId !== null) {
      throw this.notOwner();
    }

    if (audit.status === 'IN_PROGRESS') {
      const reclaimed = await this.repository.claimOwnership(scope, auditId, deviceId, [
        'IN_PROGRESS',
      ]);
      if (!reclaimed) {
        throw this.notOwner();
      }
      return this.get(scope, auditId);
    }

    const claimed = await this.repository.claimOwnership(scope, auditId, deviceId, [
      'ASSIGNED',
      'READY',
    ]);
    if (!claimed) {
      // D7: another device holds it, or the status is not one a start may begin from.
      if (audit.owningDeviceId && audit.owningDeviceId !== deviceId) {
        throw this.notOwner();
      }
      throw AppError.conflict(
        'INVALID_STATE_TRANSITION',
        `An audit that is ${audit.status} cannot be started`,
      );
    }

    const guards: TransitionGuard[] = ['device_owns_audit', 'membership_active'];

    try {
      if (audit.status === 'ASSIGNED') {
        const selfieHeld = await this.selfies.isSatisfied(scope, audit.selfieEvidenceId, auditId);
        assertTransition('audit', 'ASSIGNED', 'READY', {
          role: scope.actor.role,
          satisfied: selfieHeld ? ['selfie_captured'] : [],
        });
      }
      assertTransition('audit', 'READY', 'IN_PROGRESS', {
        role: scope.actor.role,
        satisfied: guards,
      });
    } catch (error) {
      throw asAppError(error);
    }

    // §8.6 lets `start` carry its own reading — an audit created at the gate and started
    // on the shop floor is two different places — so it is assessed again here rather than
    // leaving the creation-time flag standing for a location the auditor has left.
    const location = request.location
      ? await this.assessStartLocation(scope, audit.unitId, request.location)
      : null;

    await this.repository.updateAudit(scope, auditId, {
      status: 'IN_PROGRESS',
      startedAt: request.startedAt ? new Date(request.startedAt) : new Date(),
      pausedAt: null,
      pauseReason: null,
      ...(request.location
        ? {
            startLatitude: request.location.latitude.toFixed(6),
            startLongitude: request.location.longitude.toFixed(6),
            startAccuracyM: request.location.accuracyM?.toFixed(2) ?? null,
            startLocationProvider: request.location.provider,
            startLocationIsMocked: request.location.isMocked,
            startDistanceFromUnitM: location!.distanceM?.toFixed(2) ?? null,
            locationSuspicious: location!.suspicious,
          }
        : {}),
      clientUpdatedAt: new Date(),
    }, (tx) =>
      this.events.emit(tx, {
        type: 'AUDIT_STARTED',
        actorUserId: scope.actor.userId,
        unitId: audit.unitId,
        resourceType: 'audit',
        resourceId: auditId,
        data: { auditType: audit.auditType, locationSuspicious: location?.suspicious ?? false },
      }),
    );

    if (location?.suspicious) {
      // Logged, surfaced on the audit board, and never acted on automatically. §12.9's
      // recommendation is explicit: supporting evidence in a review process, not a gate.
      this.logger.log(
        `audit ${auditId} started with a flagged location: ${location.reasons.join(', ')}`,
      );
    }

    if (audit.assignmentId) {
      await this.assignments.setStatus(
        { ...scope, resolver: 'organization' },
        audit.assignmentId,
        'IN_PROGRESS',
      );
    }

    return this.get(scope, auditId);
  }

  /**
   * Abort (N7): save + pause + notify + resume. It has no guard, deliberately — a rule
   * that could block saving field work is a rule that loses field work.
   */
  async pause(scope: ScopeContext, auditId: string, request: PauseAuditRequest): Promise<Audit> {
    const audit = await this.mustFind(scope, auditId);

    if (audit.status === 'PAUSED') {
      return toAudit(audit);
    }

    try {
      assertTransition('audit', audit.status, 'PAUSED', { role: scope.actor.role });
    } catch (error) {
      throw asAppError(error);
    }

    // N7's Super Admin notification rides the same transaction as the pause (R-2), and
    // cannot block it: the enqueue is a row in this database, not a delivery.
    await this.repository.updateAudit(scope, auditId, {
      status: 'PAUSED',
      pausedAt: new Date(),
      pauseReason: request.reason ?? null,
      ...(request.resumeAuditZoneId ? { resumeAuditZoneId: request.resumeAuditZoneId } : {}),
      clientUpdatedAt: new Date(),
    }, (tx) =>
      this.events.emit(tx, {
        type: 'AUDIT_PAUSED',
        actorUserId: scope.actor.userId,
        unitId: audit.unitId,
        resourceType: 'audit',
        resourceId: auditId,
        data: { auditType: audit.auditType, reason: request.reason ?? null },
      }),
    );

    if (request.resumeAuditZoneId && request.resumeQuestionId) {
      await this.repository.updateZone(scope, request.resumeAuditZoneId, {
        resumeQuestionId: request.resumeQuestionId,
        clientUpdatedAt: new Date(),
      });
    }

    return this.get(scope, auditId);
  }

  async resume(scope: ScopeContext, auditId: string, request: ResumeAuditRequest): Promise<Audit> {
    const audit = await this.mustFind(scope, auditId);
    const deviceId = this.requireDevice(scope, request.deviceId);

    if (audit.status === 'IN_PROGRESS') {
      if (audit.owningDeviceId !== deviceId) {
        throw this.notOwner();
      }
      return toAudit(audit);
    }

    const claimed = await this.repository.claimOwnership(scope, auditId, deviceId, ['PAUSED']);
    if (!claimed) {
      if (audit.owningDeviceId && audit.owningDeviceId !== deviceId) {
        throw this.notOwner();
      }
      throw AppError.conflict(
        'INVALID_STATE_TRANSITION',
        `An audit that is ${audit.status} cannot be resumed`,
      );
    }

    try {
      assertTransition('audit', 'PAUSED', 'IN_PROGRESS', {
        role: scope.actor.role,
        satisfied: ['device_owns_audit', 'membership_active'],
      });
    } catch (error) {
      throw asAppError(error);
    }

    await this.repository.updateAudit(scope, auditId, {
      status: 'IN_PROGRESS',
      pausedAt: null,
      pauseReason: null,
      clientUpdatedAt: new Date(),
    });

    return this.get(scope, auditId);
  }

  /**
   * `POST /audits/{id}/complete`. The server recomputes every score on this edge (D5), so
   * whatever the device believed is replaced by what the responses say.
   */
  async complete(
    scope: ScopeContext,
    auditId: string,
    request: CompleteAuditRequest,
  ): Promise<Audit> {
    const audit = await this.mustFind(scope, auditId);

    // §8.6: a second call on a completed audit returns 200 with the same body — and since
    // Phase 6 a completed audit has usually already rolled on to its corrective actions.
    if (isAuditCompleted(audit.status)) {
      return toAudit(audit);
    }

    const zones = await this.repository.zoneCompletionState(scope, auditId);
    const allZonesCompleted = zones.total > 0 && zones.completed === zones.total;

    // §7.1's third condition on this edge: "every `audit_zone` is `COMPLETED`; ≥1 zone;
    // **walk-by zones each have ≥1 photo**."
    //
    // The third looks implied by the first — §7.2 will not complete a walk-by Zone with no
    // photograph — but it is not, and the gap is reachable without any misuse: finish a
    // Zone with its one photo, then delete that photo. E-4 permits the delete, because the
    // *audit* is still IN_PROGRESS, and the Zone stays COMPLETED. Without this check the
    // audit completes carrying a walk-by Zone that observed nothing, and a walk-by that
    // observed nothing is a walk-by with no findings and no corrective actions — the one
    // outcome §2.7 exists to produce.
    if (auditTypeRequiresZonePhoto(audit.auditType)) {
      const empty = await this.repository.zonesWithoutEvidence(scope, auditId);
      if (empty.length > 0) {
        throw AppError.conflict(
          'EVIDENCE_REQUIRED',
          `Zone ${empty.map((zone) => zone.zoneCodeSnapshot).join(', ')} has no photograph. ` +
            'A walk-by records what was seen, so every Zone needs at least one (§7.1, §7.2).',
        );
      }
    }

    try {
      assertTransition('audit', audit.status, 'COMPLETED', {
        role: scope.actor.role,
        satisfied: allZonesCompleted ? ['all_zones_completed'] : [],
      });
    } catch (error) {
      throw asAppError(error);
    }

    // Scores first, status second: the A-2 trigger freezes the audited facts the moment
    // the status lands on COMPLETED, so a recompute after it would be refused.
    await this.scoring.recompute(scope, auditId);

    // One transaction: the completion, one corrective action per nonconformity photo, the
    // audit's roll onward to CORRECTIVE_ACTION_OPEN or CLOSED, and the event (§7.1, R-2).
    // A completed audit with its actions missing is not a state this can leave behind.
    const completedAt = request.completedAt ? new Date(request.completedAt) : new Date();
    await this.repository.updateAudit(
      scope,
      auditId,
      { status: 'COMPLETED', completedAt, owningDeviceId: null, clientUpdatedAt: new Date() },
      async (tx) => {
        const outcome = await this.correctiveActions.materializeOnCompletion(
          tx,
          scope,
          auditId,
          completedAt,
        );
        await this.events.emit(tx, {
          type: 'AUDIT_COMPLETED',
          actorUserId: scope.actor.userId,
          unitId: audit.unitId,
          resourceType: 'audit',
          resourceId: auditId,
          userIds: outcome.assigneeIds,
          // Who, where and when, not just what. A Coordinator reading "5S audit completed"
          // on a phone cannot tell which of their plants it came from or who conducted it,
          // and the notification is often the only place they will see it.
          data: {
            auditType: audit.auditType,
            actionsOpened: outcome.opened,
            auditorName: audit.auditorName,
            unitName: audit.unitName,
            completedAt: completedAt.toISOString(),
          },
        });
        // The board reads the analytics rollup, which otherwise waits for 02:00: a Unit
        // whose only audit had just finished read `N/A`. Same transaction, so the rebuild
        // exists exactly when the completion does (R-2).
        await this.queue.sendInTransaction(tx, QUEUES.analyticsRollup, {
          unitId: audit.unitId,
          at: completedAt.toISOString(),
        } satisfies AnalyticsRefreshJob);
      },
    );

    if (audit.assignmentId) {
      await this.assignments.setStatus(
        { ...scope, resolver: 'organization' },
        audit.assignmentId,
        'COMPLETED',
      );
    }

    return this.get(scope, auditId);
  }

  /**
   * `POST /audits/{id}/release-device` (§9.5 Layer 1).
   *
   * > Ownership is released on `COMPLETED`, `PAUSED` (after a 24 h grace period), or by a
   * > Super Admin force-release (`POST /audits/{id}/release-device`, audit-logged) for a
   * > lost or broken phone.
   *
   * This is the third case, and it is what unblocks a lost phone. Without it a dropped
   * device holds its audit's single-writer lock indefinitely and the only remedy is a
   * psql session — which leaves no trail, on precisely the action that most needs one.
   *
   * It does not cancel the audit or touch a single answer. The audit stays exactly where
   * it was; what changes is that another device may now claim it. Any work still on the
   * lost phone is, of course, still lost — that is a property of offline-first (§9.6), and
   * the release makes the *rest* recoverable rather than pretending otherwise.
   */
  async releaseDevice(
    scope: ScopeContext,
    auditId: string,
    request: ReleaseDeviceRequest,
  ): Promise<Audit> {
    const audit = await this.mustFind(scope, auditId);

    if (audit.owningDeviceId === null) {
      // Idempotent: an audit nobody holds is already released.
      return toAudit(audit);
    }

    await this.repository.updateAudit(scope, auditId, {
      owningDeviceId: null,
      clientUpdatedAt: new Date(),
    });

    await this.auditLog.record({
      action: 'audit.device_released',
      resourceType: 'audit',
      resourceId: auditId,
      unitId: audit.unitId,
      before: { owningDeviceId: audit.owningDeviceId },
      after: { owningDeviceId: null, reason: request.reason },
    });

    this.logger.warn(
      `device ${audit.owningDeviceId} force-released from audit ${auditId}: ${request.reason}`,
    );

    return this.get(scope, auditId);
  }

  /** Administrative voiding. Every row is retained — that is the whole of A-1. */
  async cancel(scope: ScopeContext, auditId: string, request: CancelAuditRequest): Promise<Audit> {
    const audit = await this.mustFind(scope, auditId);

    if (audit.status === 'CANCELLED') {
      return toAudit(audit);
    }

    try {
      assertTransition('audit', audit.status, 'CANCELLED', {
        role: scope.actor.role,
        satisfied: ['reason_given'],
      });
    } catch (error) {
      throw asAppError(error);
    }

    await this.repository.updateAudit(scope, auditId, {
      status: 'CANCELLED',
      owningDeviceId: null,
      clientUpdatedAt: new Date(),
    });

    await this.auditLog.record({
      action: 'audit.cancelled',
      resourceType: 'audit',
      resourceId: auditId,
      unitId: audit.unitId,
      before: { status: audit.status },
      after: { status: 'CANCELLED', reason: request.reason },
    });

    return this.get(scope, auditId);
  }

  /**
   * `PATCH /audits/{id}/post-completion` — the **only** way a completed audit changes.
   *
   * A-2's carve-out is opened here and nowhere else, inside the same transaction that
   * writes the `AuditLog` entry with before and after. Without an endpoint like this the
   * override happens in someone's psql session and leaves no trail at all, which is the
   * outcome the invariant exists to prevent.
   *
   * R-30 widened who may call it — a Super Admin for any audit, a Consultant for one they
   * conducted — and nothing in this method had to change for that. The grant decides who
   * arrives; `mustFind` under the `own_audits` resolver decides which audits they find;
   * the justification and the log entry are required of both.
   */
  async postCompletionOverride(
    scope: ScopeContext,
    auditId: string,
    request: PostCompletionOverrideRequest,
  ): Promise<AuditDetail> {
    const audit = await this.mustFind(scope, auditId);

    if (!isAuditCompleted(audit.status)) {
      throw AppError.conflict(
        'INVALID_STATE_TRANSITION',
        'This audit is not completed; edit it through the ordinary endpoints',
      );
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (request.changes.reopenAuditZoneId) {
      const zone = await this.repository.findZone(scope, request.changes.reopenAuditZoneId);
      if (!zone || zone.auditId !== auditId) {
        throw AppError.notFound('No such audit Zone on this audit');
      }
      try {
        assertTransition('audit_zone', zone.status, 'IN_PROGRESS', {
          role: scope.actor.role,
          satisfied: ['reason_given'],
        });
      } catch (error) {
        throw asAppError(error);
      }
      before.zoneStatus = { [zone.id]: zone.status };
      after.zoneStatus = { [zone.id]: 'IN_PROGRESS' };
    }

    if (request.changes.zoneRemark) {
      const zone = await this.repository.findZone(scope, request.changes.zoneRemark.auditZoneId);
      if (!zone || zone.auditId !== auditId) {
        throw AppError.notFound('No such audit Zone on this audit');
      }
      before.zoneRemark = { [zone.id]: zone.zoneRemark };
      after.zoneRemark = { [zone.id]: request.changes.zoneRemark.remark };
    }

    const responseChanges = request.changes.responses ?? [];
    if (responseChanges.length > 0) {
      const beforeValues: Record<string, unknown> = {};
      const afterValues: Record<string, unknown> = {};
      for (const change of responseChanges) {
        const existing = await this.repository.findResponseById(scope, change.responseId);
        if (!existing || existing.auditId !== auditId) {
          throw AppError.notFound('No such response on this audit');
        }
        beforeValues[change.responseId] = { value: existing.value, remark: existing.remark };
        afterValues[change.responseId] = { value: change.value, remark: change.remark };
      }
      before.responses = beforeValues;
      after.responses = afterValues;
    }

    /**
     * R-31: a corrected mark does not stop at the response row.
     *
     * The photograph filed under it is reclassified (E-2, which has always done this
     * before completion and now does it after), and the corrective actions follow — one
     * raised where a finding has appeared, one withdrawn where a finding has gone. All of
     * it on the override's own transaction, so a correction and its consequences commit
     * together or not at all.
     */
    await this.repository.applyPostCompletionOverride(
      scope,
      {
        auditId,
        unitId: audit.unitId,
        ...(request.changes.reopenAuditZoneId
          ? { reopenAuditZoneId: request.changes.reopenAuditZoneId }
          : {}),
        ...(request.changes.zoneRemark ? { zoneRemark: request.changes.zoneRemark } : {}),
        responses: responseChanges.map((change) => ({
          responseId: change.responseId,
          value: change.value,
          remark: change.remark ?? null,
        })),
        before,
        after: { ...after, justification: request.justification },
        requestId: getRequestContext()?.requestId ?? 'post-completion-override',
      },
      responseChanges.length === 0
        ? undefined
        : async (tx) => {
            for (const change of responseChanges) {
              await this.evidence.reclassifyForResponseOn(tx, change.responseId, change.value);
            }
            const cascaded = await this.correctiveActions.cascadeAfterCorrection(tx, scope, auditId);
            await this.announceCascade(tx, scope, audit, cascaded);
          },
    );

    // Scores are recomputed under the same carve-out, because the audit is still frozen.
    if (responseChanges.length > 0) {
      await this.recomputeUnderOverride(scope, auditId);
    }

    return this.detail(scope, auditId);
  }

  /**
   * Tells the people a cascade moved work for (R-31).
   *
   * On the override's own transaction, which is R-2 without an exception: the notification
   * exists exactly when the finding it announces does. A Zone Leader told to go and fix
   * something that rolled back would be the worse half of the bug this whole cascade
   * exists to close — and a new finding nobody was told about is the other half.
   *
   * A-2's carve-out is open on this transaction, and a `pg_boss` job row is untouched by
   * it: the carve-out is read by the freeze triggers on the audit tables and by nothing
   * else.
   */
  private async announceCascade(
    tx: Transaction,
    scope: ScopeContext,
    audit: AuditRow,
    cascaded: Awaited<ReturnType<CorrectiveActionsService['cascadeAfterCorrection']>>,
  ): Promise<void> {
    for (const action of cascaded.opened) {
      await this.events.emit(tx, {
        type: 'CORRECTIVE_ACTION_OPENED',
        actorUserId: scope.actor.userId,
        unitId: audit.unitId,
        resourceType: 'corrective_action',
        resourceId: action.id,
        userIds: action.assignedZoneLeaderUserId ? [action.assignedZoneLeaderUserId] : [],
        data: {
          auditId: audit.id,
          auditType: audit.auditType,
          auditorName: audit.auditorName,
          zoneCode: action.zoneCode,
          zoneName: action.zoneName,
          questionNo: action.questionGlobalOrder,
          value: action.scoreAtCapture,
        },
      });
    }

    for (const action of cascaded.withdrawn) {
      await this.events.emit(tx, {
        type: 'CORRECTIVE_ACTION_WITHDRAWN',
        actorUserId: scope.actor.userId,
        unitId: audit.unitId,
        resourceType: 'corrective_action',
        resourceId: action.id,
        userIds: action.assignedZoneLeaderUserId ? [action.assignedZoneLeaderUserId] : [],
        data: { auditId: audit.id, auditType: audit.auditType, auditorName: audit.auditorName },
      });
    }

    if (cascaded.opened.length > 0 || cascaded.withdrawn.length > 0) {
      this.logger.log(
        `override on audit ${audit.id}: ${cascaded.opened.length} corrective action(s) opened, ` +
          `${cascaded.withdrawn.length} withdrawn; audit is ${cascaded.auditStatus} (R-31)`,
      );
    }
  }

  /** Recomputes and persists scores on a frozen audit, inside the A-2 carve-out. */
  private async recomputeUnderOverride(scope: ScopeContext, auditId: string): Promise<void> {
    const { scored, audit, zones } = await this.scoring.summarise(scope, auditId);

    if (!scored) {
      // A walk-by has no responses to have corrected, so an override can only have
      // touched a Zone remark. Writing zeros here would be the same mistake `recompute`
      // avoids, and this path writes them *inside* the A-2 carve-out where the trigger
      // would not stop it.
      return;
    }

    await this.repository.writeScoresUnderOverride(scope, auditId, {
      audit: audit.totals,
      zones: [...zones.entries()].map(([auditZoneId, breakdown]) => ({
        auditZoneId,
        totals: breakdown.totals,
        sections: breakdown.sections.map((section) => ({
          section: section.section,
          applicableQuestions: section.applicableQuestions,
          naQuestions: section.naQuestions,
          rawScore: section.rawScore,
          maxScore: section.maxScore,
          scorePercentage: section.scorePercentage,
        })),
      })),
    });
  }

  /**
   * §12.9's server-side assessment.
   *
   * The Unit is read under `unit:read`, and a Unit the actor cannot read yields no
   * coordinates — which `assessLocation` reports as `UNIT_NOT_GEOCODED` rather than as a
   * clean bill. Failing safe here means "we could not check", never "it checked out".
   */
  private async assessStartLocation(
    scope: ScopeContext,
    unitId: string,
    reading: CreateAuditRequest['location'],
  ): Promise<LocationAssessment> {
    const unit = await this.repository.readUnitGeofence(scope, unitId);
    return assessLocation(reading ?? null, {
      latitude: unit?.latitude === undefined || unit?.latitude === null ? null : Number(unit.latitude),
      longitude:
        unit?.longitude === undefined || unit?.longitude === null ? null : Number(unit.longitude),
      geofenceRadiusM: unit?.geofenceRadiusM ?? null,
    });
  }

  // ------------------------------------------------------------------------ helpers

  async mustFind(scope: ScopeContext, auditId: string): Promise<AuditRow> {
    const audit = await this.repository.findById(scope, auditId);
    if (!audit) {
      throw AppError.notFound('No such audit');
    }
    return audit;
  }

  /**
   * Whether this actor may conduct an audit on `deviceId`.
   *
   * There is exactly one way to fail this, and it is worth naming because the old message
   * — "Unknown device" — suggested a different one. A session cannot be bound to a device
   * that was never registered: `refresh_token.device_id` references `device`, so such a
   * login is refused outright, and `requireDevice` then makes the token's id the only one
   * a request may use. The row therefore always exists. What it may not be is *this*
   * actor's, and since login hands a handset to whoever signs in on it, that means the
   * phone moved on while this session did not.
   */
  private async requireOwnDevice(scope: ScopeContext, deviceId: string): Promise<void> {
    if (await this.repository.isOwnDevice(scope, deviceId)) {
      return;
    }

    throw AppError.validation('This device belongs to another account', [
      {
        field: 'deviceId',
        message:
          'Somebody else has since signed in on this device, or it has been revoked. ' +
          'Sign in again to continue on it.',
      },
    ]);
  }

  /**
   * The device claim, from the body or `X-Device-Id`.
   *
   * An audit is a device's work: without one there is nothing to hold the single-writer
   * lock, so a web session cannot start one however privileged its actor is.
   */
  private requireDevice(scope: ScopeContext, bodyDeviceId: string | undefined): string {
    const deviceId = bodyDeviceId ?? scope.actor.deviceId;
    if (!deviceId) {
      throw AppError.validation('This request must identify the device conducting the audit', [
        { field: 'deviceId', message: 'Send deviceId, or the X-Device-Id header' },
      ]);
    }
    if (bodyDeviceId && scope.actor.deviceId && bodyDeviceId !== scope.actor.deviceId) {
      // The token binds a device; a body claiming a different one is a red flag.
      throw AppError.forbidden('DEVICE_NOT_OWNER', 'This session is bound to another device');
    }
    return deviceId;
  }

  private notOwner(): AppError {
    return AppError.conflict(
      'DEVICE_NOT_OWNER',
      'Another device is conducting this audit. It must finish or abort it first (D7).',
    );
  }

  /**
   * The assignment an external audit fulfils, if there is one (R-20).
   *
   * Access to the Unit is enough to run an external audit; an assignment is not required.
   * When an open one exists it is linked, so it still moves through its statuses with the
   * audit. When none does, the audit starts unassigned, as a Super Admin's always has
   * (R-18). Cross and walk-by audits are self-initiated (§2.6, §2.7) and carry none.
   */
  private async resolveAssignment(
    scope: ScopeContext,
    request: CreateAuditRequest,
  ): Promise<string | null> {
    if (request.auditType !== 'EXTERNAL_5S') {
      return request.assignmentId ?? null;
    }

    // R-18: a Super Admin is never assigned work, so there is nothing to link.
    if (scope.actor.role === 'SUPER_ADMIN') {
      return null;
    }

    const assignmentScope = scopeFor(scope, 'audit_assignment:read');

    if (request.assignmentId) {
      const assignment = await this.assignments.findById(assignmentScope, request.assignmentId);
      if (!assignment || assignment.auditorUserId !== scope.actor.userId) {
        throw AppError.notFound('No such assignment');
      }
      return assignment.id;
    }

    const open = await this.assignments.findOpenForUnit(
      assignmentScope,
      scope.actor.userId,
      request.unitId,
      'EXTERNAL_5S',
    );
    return open?.id ?? null;
  }
}

export function toAudit(row: AuditRow): Audit {
  return {
    id: row.id,
    assignmentId: row.assignmentId,
    unitId: row.unitId,
    unitName: row.unitName,
    auditType: row.auditType,
    // §2.7, PART 11: a walk-by has no score, and `totals` alone cannot say so — all-zero
    // totals with a null percentage look identical to a scored audit nobody has answered.
    scored: isScoredAuditType(row.auditType),
    status: row.status as AuditStatus,
    auditorUserId: row.auditorUserId,
    auditorName: row.auditorName,
    owningDeviceId: row.owningDeviceId,
    checklistVersionId: row.checklistVersionId,
    selfieEvidenceId: row.selfieEvidenceId,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    startLatitude: numberOrNull(row.startLatitude),
    startLongitude: numberOrNull(row.startLongitude),
    startAccuracyM: numberOrNull(row.startAccuracyM),
    startLocationProvider: row.startLocationProvider,
    startLocationIsMocked: row.startLocationIsMocked,
    startDistanceFromUnitM: numberOrNull(row.startDistanceFromUnitM),
    locationSuspicious: row.locationSuspicious,
    totals: {
      applicableQuestions: row.applicableQuestions ?? 0,
      naQuestions: row.naQuestions ?? 0,
      rawScore: row.rawScore ?? 0,
      maxScore: row.maxScore ?? 0,
      scorePercentage: numberOrNull(row.totalScore),
    },
    pausedAt: row.pausedAt?.toISOString() ?? null,
    pauseReason: row.pauseReason,
    resumeAuditZoneId: row.resumeAuditZoneId,
    clientCreatedAt: row.clientCreatedAt.toISOString(),
    clientUpdatedAt: row.clientUpdatedAt.toISOString(),
    serverReceivedAt: row.serverReceivedAt.toISOString(),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAuditZone(
  row: AuditZoneRow,
  sections: Array<{
    section: string;
    applicableQuestions: number;
    naQuestions: number;
    rawScore: number;
    maxScore: number;
    scorePercentage: string | null;
  }>,
): AuditZone {
  return {
    id: row.id,
    auditId: row.auditId,
    zoneId: row.zoneId,
    sequenceNo: row.sequenceNo,
    status: row.status,
    zoneCodeSnapshot: row.zoneCodeSnapshot,
    zoneNameSnapshot: row.zoneNameSnapshot,
    zoneDescriptionSnapshot: row.zoneDescriptionSnapshot,
    zoneLeaderUserIdSnapshot: row.zoneLeaderUserIdSnapshot,
    zoneLeaderNameSnapshot: row.zoneLeaderNameSnapshot,
    checklistVersionId: row.checklistVersionId,
    checklistTemplateNameSnapshot: row.checklistTemplateNameSnapshot,
    zoneRemark: row.zoneRemark,
    totals: {
      applicableQuestions: row.applicableQuestions,
      naQuestions: row.naQuestions,
      rawScore: row.rawScore,
      maxScore: row.maxScore,
      scorePercentage: numberOrNull(row.scorePercentage),
    },
    sections: sections.map((section) => ({
      section: section.section as AuditZone['sections'][number]['section'],
      applicable: section.applicableQuestions,
      na: section.naQuestions,
      raw: section.rawScore,
      max: section.maxScore,
      pct: numberOrNull(section.scorePercentage),
    })),
    resumeQuestionId: row.resumeQuestionId,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    clientUpdatedAt: row.clientUpdatedAt.toISOString(),
    version: row.version,
  };
}

export function toQuestionResponse(row: QuestionResponseRow): QuestionResponse {
  return {
    id: row.id,
    auditZoneId: row.auditZoneId,
    auditId: row.auditId,
    checklistQuestionId: row.checklistQuestionId,
    section: row.section,
    globalOrder: row.globalOrder,
    value: row.value,
    numericScore: row.numericScore,
    remark: row.remark,
    answeredAt: row.answeredAt.toISOString(),
    clientUpdatedAt: row.clientUpdatedAt.toISOString(),
    syncState: row.syncState,
  };
}

/** `numeric` arrives from `pg` as a string, so it is parsed once here rather than at each use. */
function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export { toScoreSummary, toSection, toTotals };
