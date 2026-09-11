import { Injectable } from '@nestjs/common';
import type {
  AuditZone,
  CompleteAuditZoneRequest,
  UpsertAuditZoneRequest,
} from '@audit5s/contracts';
import { assertTransition, type ScopeContext, type TransitionGuard } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { isUniqueViolation } from '../../common/pg-errors';
import { asAppError } from '../audit-assignments/assignments.service';
import { AuditsRepository, type AuditRow, type ZoneSnapshot } from '../audits/audits.repository';
import { ScoringService } from '../audits/scoring.service';
import { toAuditZone } from '../audits/audits.service';
import { EvidenceService } from '../evidence/evidence.service';

/**
 * Audit Zones (§7.2, §8.6).
 *
 * The one rule worth reading this file for is D6. On the **first** write of an audit Zone
 * the server copies the live Zone's code, name, description, leader id and leader name,
 * plus the checklist version's department label, onto the row. On every later write it
 * copies nothing. That is why a Coordinator may keep editing Zone master data — the
 * report renders the copy, and history cannot move under it.
 *
 * A client cannot supply a snapshot. The upsert contract has no field for one, and the
 * repository writes them only in the INSERT branch, so "the device sent a different name"
 * is not a case that has to be defended against.
 */
@Injectable()
export class AuditZonesService {
  constructor(
    private readonly repository: AuditsRepository,
    private readonly scoring: ScoringService,
    private readonly evidence: EvidenceService,
  ) {}

  async upsert(
    scope: ScopeContext,
    auditId: string,
    auditZoneId: string,
    request: UpsertAuditZoneRequest,
  ): Promise<AuditZone> {
    const audit = await this.mustFindAudit(scope, auditId);
    this.assertWritable(scope, audit);

    const existing = await this.repository.findZone(scope, auditZoneId);
    if (existing && existing.auditId !== auditId) {
      throw AppError.conflict('CONFLICT', 'This audit Zone belongs to another audit');
    }

    const zone = await this.repository.readZoneSnapshot(scope, request.zoneId);
    if (!zone) {
      throw AppError.notFound('No such Zone');
    }
    if (zone.unitId !== audit.unitId) {
      // A Zone of another Unit would produce an audit whose report names a plant the
      // auditor never visited.
      throw AppError.validation('That Zone belongs to a different Unit', [
        { field: 'zoneId', message: 'Not a Zone of this audit’s Unit' },
      ]);
    }
    if (zone.archivedAt && !existing) {
      throw AppError.validation('That Zone is archived', [
        { field: 'zoneId', message: 'Archived Zones cannot be added to an audit' },
      ]);
    }

    const checklistVersionId = request.checklistVersionId ?? audit.checklistVersionId ?? null;
    const templateName = checklistVersionId
      ? await this.repository.readTemplateNameForVersion(scope, checklistVersionId)
      : null;

    const snapshot: ZoneSnapshot = {
      zoneCodeSnapshot: zone.code,
      zoneNameSnapshot: zone.name,
      zoneDescriptionSnapshot: zone.description,
      zoneLeaderUserIdSnapshot: zone.zoneLeaderId,
      zoneLeaderNameSnapshot: zone.zoneLeaderName,
      checklistTemplateNameSnapshot: templateName,
    };

    try {
      await this.repository.upsertZone(scope, {
        id: auditZoneId,
        auditId,
        zoneId: request.zoneId,
        sequenceNo: request.sequenceNo,
        checklistVersionId,
        zoneRemark: request.zoneRemark,
        resumeQuestionId: request.resumeQuestionId,
        clientUpdatedAt: request.clientUpdatedAt ? new Date(request.clientUpdatedAt) : new Date(),
        snapshot,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'audit_zone_audit_zone_key')) {
        throw AppError.conflict(
          'ZONE_ALREADY_IN_AUDIT',
          'This Zone is already part of this audit. A Zone appears at most once per audit.',
        );
      }
      if (isUniqueViolation(error, 'audit_zone_sequence_key')) {
        throw AppError.conflict('CONFLICT', 'Another Zone already holds that position');
      }
      throw error;
    }

    return this.get(scope, auditZoneId);
  }

  async get(scope: ScopeContext, auditZoneId: string): Promise<AuditZone> {
    const zone = await this.repository.findZone(scope, auditZoneId);
    if (!zone) {
      throw AppError.notFound('No such audit Zone');
    }
    const sections = (await this.repository.listSectionScores(scope, zone.auditId)).filter(
      (section) => section.auditZoneId === auditZoneId,
    );
    return toAuditZone(zone, sections);
  }

  /**
   * `POST /audits/{auditId}/zones/{auditZoneId}/complete`.
   *
   * The guard of §7.2 for a scored audit is that every question of the **pinned** version
   * has a response — pinned, not current, so a republish mid-audit neither adds a question
   * the auditor never saw nor removes one they answered.
   */
  async complete(
    scope: ScopeContext,
    auditId: string,
    auditZoneId: string,
    request: CompleteAuditZoneRequest,
  ): Promise<AuditZone> {
    const audit = await this.mustFindAudit(scope, auditId);
    const zone = await this.repository.findZone(scope, auditZoneId);
    if (!zone || zone.auditId !== auditId) {
      throw AppError.notFound('No such audit Zone on this audit');
    }

    if (zone.status === 'COMPLETED') {
      // Idempotent: a retried finish returns the Zone rather than raising.
      return this.get(scope, auditZoneId);
    }

    this.assertWritable(scope, audit);

    // §7.2 gives this edge two forms, and which one applies is decided by the audit type,
    // not by which happens to be satisfiable. A walk-by needs a photograph; a scored Zone
    // needs its answers. Resolving the applicable guard here — rather than offering both
    // and letting the table pick — is what stops a fifty-question Zone completing on the
    // strength of one photo and no answers.
    const satisfied: TransitionGuard[] = [];

    if (audit.auditType === 'WALK_BY') {
      if (!(await this.evidence.hasEvidenceInZone(scope, auditZoneId))) {
        // Named rather than left to the generic guard refusal, because this is the one an
        // auditor standing in the Zone can act on: take a photograph.
        throw AppError.conflict(
          'EVIDENCE_REQUIRED',
          'A walk-by Zone needs at least one photograph before it can be finished (§7.2)',
        );
      }
      satisfied.push('has_evidence');
    } else if (await this.answeredEveryQuestion(scope, zone.checklistVersionId, auditZoneId)) {
      satisfied.push('all_questions_answered');
    }

    try {
      assertTransition('audit_zone', zone.status, 'COMPLETED', {
        role: scope.actor.role,
        satisfied,
      });
    } catch (error) {
      throw asAppError(error);
    }

    await this.repository.updateZone(scope, auditZoneId, {
      status: 'COMPLETED',
      completedAt: request.completedAt ? new Date(request.completedAt) : new Date(),
      ...(request.zoneRemark !== undefined ? { zoneRemark: request.zoneRemark } : {}),
      // The cursor is cleared: a finished Zone has nowhere to resume to.
      resumeQuestionId: null,
      clientUpdatedAt: new Date(),
    });

    // Section scores are written on this edge (§7.2), by the same pure function the device
    // used, so the radar chart and the S-trend read a materialised copy of it.
    await this.scoring.recompute(scope, auditId);

    return this.get(scope, auditZoneId);
  }

  /**
   * Every question of the pinned version has an answer.
   *
   * A walk-by pins no version and has no questions, so this is vacuously *not* the guard
   * that applies to it — `has_evidence` is, and the state-machine table names which edge
   * needs which. Returning `true` here for a walk-by, as Phase 3 did while `evidence` did
   * not exist, would have let a walk-by Zone finish with no photograph at all.
   */
  private async answeredEveryQuestion(
    scope: ScopeContext,
    checklistVersionId: string | null,
    auditZoneId: string,
  ): Promise<boolean> {
    if (!checklistVersionId) {
      return false;
    }
    const [expected, actual] = await Promise.all([
      this.repository.countQuestionsInVersion(scope, checklistVersionId),
      this.repository.countResponsesInZone(scope, auditZoneId),
    ]);
    return expected > 0 && actual >= expected;
  }

  private async mustFindAudit(scope: ScopeContext, auditId: string): Promise<AuditRow> {
    const audit = await this.repository.findById(scope, auditId);
    if (!audit) {
      throw AppError.notFound('No such audit');
    }
    return audit;
  }

  /**
   * The device-owner condition PART 6 states in prose on `audit_zone:create/update` — and
   * A-2's application half, so a completed audit refuses the write before the trigger has
   * to.
   */
  private assertWritable(scope: ScopeContext, audit: AuditRow): void {
    if (['COMPLETED', 'CORRECTIVE_ACTION_OPEN', 'PARTIALLY_CLOSED', 'CLOSED'].includes(audit.status)) {
      throw AppError.conflict(
        'AUDIT_ALREADY_COMPLETED',
        'This audit is completed. Use the post-completion override, which is audit-logged (A-2).',
      );
    }
    if (audit.status === 'CANCELLED') {
      throw AppError.conflict('INVALID_STATE_TRANSITION', 'This audit was cancelled');
    }
    if (scope.actor.deviceId && audit.owningDeviceId && audit.owningDeviceId !== scope.actor.deviceId) {
      throw AppError.conflict(
        'DEVICE_NOT_OWNER',
        'Another device is conducting this audit. It must finish or abort it first (D7).',
      );
    }
  }
}
