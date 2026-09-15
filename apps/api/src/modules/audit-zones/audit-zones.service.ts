import { Injectable } from '@nestjs/common';
import type {
  AuditZone,
  CompleteAuditZoneRequest,
  UpsertAuditZoneRequest,
} from '@audit5s/contracts';
import {
  assertTransition,
  auditTypeRequiresZonePhoto,
  auditTypeUsesChecklist,
  isAuditCompleted,
  zoneCodeForNumber,
  zoneLeaderSnapshot,
  type ScopeContext,
  type TransitionGuard,
} from '@audit5s/domain';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
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
 * What the auditor enters when creating the Zone is part of that first write (R-19): the
 * Zone 1…100 they chose, an optional description and the Zone leader's name as typed, on
 * every audit type. A Zone number the Unit has never used is added to its master list here,
 * which is the one way a Consultant or Zone Leader adds a Zone. A walk-by may still name a
 * leader account instead (§2.7 step 4), and that account must hold an ACTIVE `ZONE_LEADER`
 * membership in the audit's Unit.
 */
@Injectable()
export class AuditZonesService {
  constructor(
    private readonly repository: AuditsRepository,
    private readonly scoring: ScoringService,
    private readonly evidence: EvidenceService,
    private readonly auditLog: AuditLogService,
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

    // A Zone already on this audit keeps the master Zone it was created with. Only a first
    // write resolves one — and, for a Zone number the Unit has never used, adds it.
    const zoneId = existing?.zoneId ?? (await this.resolveZone(scope, audit, auditId, request));

    const zone = await this.repository.readZoneSnapshot(scope, zoneId);
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

    // §2.7: a walk-by pins nothing, and 0008's trigger refuses it outright. Dropped rather
    // than refused when the audit-level default carries one, because a device that started
    // a walk-by from a screen holding a version id is not making a claim about the Zone.
    const usesChecklist = auditTypeUsesChecklist(audit.auditType);
    if (usesChecklist === false && request.checklistVersionId) {
      throw AppError.validation('A walk-by Zone has no questionnaire', [
        {
          field: 'checklistVersionId',
          message: 'A WALK_BY Zone pins no checklist version (§2.7, QR-2)',
        },
      ]);
    }

    const checklistVersionId = usesChecklist
      ? (request.checklistVersionId ?? audit.checklistVersionId ?? null)
      : null;
    const templateName = checklistVersionId
      ? await this.repository.readTemplateNameForVersion(scope, checklistVersionId)
      : null;

    // A walk-by's leader account (§2.7 step 4) wins; otherwise the typed name (R-19), and
    // failing both, the Zone's own leader.
    const account = await this.resolveWalkByLeader(scope, audit, request);
    const leader = account
      ? { userId: account.id, name: account.fullName }
      : zoneLeaderSnapshot(zone, request.zoneLeaderName);

    const snapshot: ZoneSnapshot = {
      zoneCodeSnapshot: zone.code,
      zoneNameSnapshot: zone.name,
      zoneDescriptionSnapshot: request.zoneDescription?.trim() || zone.description,
      zoneLeaderUserIdSnapshot: leader.userId,
      zoneLeaderNameSnapshot: leader.name,
      checklistTemplateNameSnapshot: templateName,
    };

    try {
      await this.repository.upsertZone(scope, {
        id: auditZoneId,
        auditId,
        zoneId,
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

    if (auditTypeRequiresZonePhoto(audit.auditType)) {
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

  /**
   * R-19: the master Zone a first write names. A Zone number is found in the audit's Unit
   * or added to it, through `app_ensure_zone_for_audit` (0014), which answers only for an
   * open audit the actor is conducting. An added Zone is logged like one a Coordinator
   * creates, so the master list never gains a row nobody can account for.
   */
  private async resolveZone(
    scope: ScopeContext,
    audit: AuditRow,
    auditId: string,
    request: UpsertAuditZoneRequest,
  ): Promise<string> {
    if (request.zoneNumber === undefined) {
      // The contract refuses a body that names neither.
      return request.zoneId!;
    }

    const code = zoneCodeForNumber(request.zoneNumber);
    const name = `Zone ${request.zoneNumber}`;
    const ensured = await this.repository.ensureZoneForAudit(scope, {
      auditId,
      code,
      name,
      description: request.zoneDescription?.trim() || null,
      sortOrder: request.zoneNumber,
    });
    if (!ensured) {
      throw AppError.notFound('No such audit');
    }

    if (ensured.created) {
      await this.auditLog.record({
        action: 'zone.created',
        resourceType: 'zone',
        resourceId: ensured.zoneId,
        unitId: audit.unitId,
        after: { code, name, addedByAuditId: auditId },
      });
    }
    return ensured.zoneId;
  }

  /**
   * §2.7 step 4: the Zone leader a walk-by auditor confirmed or selected.
   *
   * Null means "use the Zone's own leader", which is both the absent case and the
   * "confirmed" case — confirming the current leader and saying nothing produce the same
   * snapshot, so the flow does not need to distinguish them.
   *
   * The membership is the check, not the role on the user row: C2 is explicit that the
   * Zone's leader pointer grants nothing, and a Zone Leader of another Unit standing in
   * this Zone's snapshot would put a name on a report for a plant they do not work in.
   */
  private async resolveWalkByLeader(
    scope: ScopeContext,
    audit: AuditRow,
    request: UpsertAuditZoneRequest,
  ): Promise<{ id: string; fullName: string } | null> {
    if (!request.zoneLeaderUserId || auditTypeUsesChecklist(audit.auditType)) {
      return null;
    }

    const leader = await this.repository.readZoneLeaderForUnit(
      scope,
      audit.unitId,
      request.zoneLeaderUserId,
    );
    if (!leader) {
      throw AppError.validation('The named Zone Leader is not an active member of this Unit', [
        { field: 'zoneLeaderUserId', message: 'Not an active Zone Leader of this Unit' },
      ]);
    }
    return leader;
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
    if (isAuditCompleted(audit.status)) {
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
