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
  ResumeAuditRequest,
  StartAuditRequest,
} from '@audit5s/contracts';
import {
  assertTransition,
  assessLocation,
  type LocationAssessment,
  type ScopeContext,
  type TransitionGuard,
} from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
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

    const unit = await this.units.findById(scope, request.unitId);
    if (!unit) {
      // AZ-3: a Unit outside scope reads as absent, so ids cannot be probed.
      throw AppError.notFound('No such Unit');
    }

    const assignmentId = await this.resolveAssignment(scope, request);
    const deviceId = this.requireDevice(scope, request.deviceId);

    if (!(await this.repository.isOwnDevice(scope, deviceId))) {
      throw AppError.validation('Unknown device', [
        { field: 'deviceId', message: 'Register the device before starting an audit' },
      ]);
    }

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
    if (audit.status === 'IN_PROGRESS') {
      if (audit.owningDeviceId !== deviceId) {
        throw this.notOwner();
      }
      return toAudit(audit);
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
    });

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

    await this.repository.updateAudit(scope, auditId, {
      status: 'PAUSED',
      pausedAt: new Date(),
      pauseReason: request.reason ?? null,
      ...(request.resumeAuditZoneId ? { resumeAuditZoneId: request.resumeAuditZoneId } : {}),
      clientUpdatedAt: new Date(),
    });

    if (request.resumeAuditZoneId && request.resumeQuestionId) {
      await this.repository.updateZone(scope, request.resumeAuditZoneId, {
        resumeQuestionId: request.resumeQuestionId,
        clientUpdatedAt: new Date(),
      });
    }

    // The Super Admin notification of N7 is a `notification` row, which arrives with the
    // notifications module in Phase 6. The pause itself is never blocked on it (§9.8).
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

    // §8.6: a second call on a COMPLETED audit returns 200 with the same body.
    if (audit.status === 'COMPLETED') {
      return toAudit(audit);
    }

    const zones = await this.repository.zoneCompletionState(scope, auditId);
    const allZonesCompleted = zones.total > 0 && zones.completed === zones.total;

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

    await this.repository.updateAudit(scope, auditId, {
      status: 'COMPLETED',
      completedAt: request.completedAt ? new Date(request.completedAt) : new Date(),
      owningDeviceId: null,
      clientUpdatedAt: new Date(),
    });

    if (audit.assignmentId) {
      await this.assignments.setStatus(
        { ...scope, resolver: 'organization' },
        audit.assignmentId,
        'COMPLETED',
      );
    }

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
   */
  async postCompletionOverride(
    scope: ScopeContext,
    auditId: string,
    request: PostCompletionOverrideRequest,
  ): Promise<AuditDetail> {
    const audit = await this.mustFind(scope, auditId);

    if (!['COMPLETED', 'CORRECTIVE_ACTION_OPEN', 'PARTIALLY_CLOSED', 'CLOSED'].includes(audit.status)) {
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

    await this.repository.applyPostCompletionOverride(scope, {
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
    });

    // Scores are recomputed under the same carve-out, because the audit is still frozen.
    if (responseChanges.length > 0) {
      await this.recomputeUnderOverride(scope, auditId);
    }

    return this.detail(scope, auditId);
  }

  /** Recomputes and persists scores on a frozen audit, inside the A-2 carve-out. */
  private async recomputeUnderOverride(scope: ScopeContext, auditId: string): Promise<void> {
    const { audit, zones } = await this.scoring.summarise(scope, auditId);

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
   * The matrix condition on `audit:create_external` — "an active assignment must exist".
   *
   * Cross and walk-by audits are self-initiated (§2.6, §2.7) and carry no assignment, so
   * the requirement is stated for the one type that has it rather than for all three.
   */
  private async resolveAssignment(
    scope: ScopeContext,
    request: CreateAuditRequest,
  ): Promise<string | null> {
    if (request.auditType !== 'EXTERNAL_5S') {
      return request.assignmentId ?? null;
    }

    if (request.assignmentId) {
      const assignment = await this.assignments.findById(scope, request.assignmentId);
      if (!assignment || assignment.auditorUserId !== scope.actor.userId) {
        throw AppError.notFound('No such assignment');
      }
      return assignment.id;
    }

    const open = await this.assignments.findOpenForUnit(
      scope,
      scope.actor.userId,
      request.unitId,
      'EXTERNAL_5S',
    );
    if (!open) {
      throw AppError.forbidden(
        'ASSIGNMENT_REQUIRED',
        'An external audit needs an open assignment for this Unit',
      );
    }
    return open.id;
  }
}

export function toAudit(row: AuditRow): Audit {
  return {
    id: row.id,
    assignmentId: row.assignmentId,
    unitId: row.unitId,
    unitName: row.unitName,
    auditType: row.auditType,
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
