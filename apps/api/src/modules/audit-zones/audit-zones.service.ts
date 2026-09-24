import { Injectable } from '@nestjs/common';
import type {
  AuditZone,
  CompleteAuditZoneRequest,
  UpsertAuditZoneRequest,
  WithdrawAuditZoneRequest,
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
    // A withdrawn Zone stays as it was left. A late upsert queued before the withdrawal is
    // accepted and changes nothing, rather than bringing the Zone back into the audit.
    if (existing?.status === 'WITHDRAWN') {
      return this.get(scope, auditZoneId);
    }

    /*
     * R-34: while the audit is **open**, the auditor may re-point this audit Zone at a
     * different Zone number — they typed it, and a typo was previously permanent.
     *
     * Once the audit is finished it keeps the Zone it was created with, which is D6: a
     * report issued today does not change its subject next month. A cancelled audit keeps
     * it too; there is nothing to correct in a voided record.
     */
    const editable = !isAuditCompleted(audit.status) && audit.status !== 'CANCELLED';
    const zoneId =
      existing && !editable
        ? existing.zoneId
        : await this.resolveZone(scope, audit, auditId, request);

    // Re-pointing an existing audit Zone is subject to the same two refusals a first write
    // earns: the Unit's other open audits still hold what they hold (R-29), and one Zone
    // still appears at most once per audit.
    if (existing && zoneId !== existing.zoneId) {
      const alreadyInAudit = await this.repository.listZones(scope, auditId);
      if (alreadyInAudit.some((zone) => zone.zoneId === zoneId && zone.status !== 'WITHDRAWN')) {
        throw AppError.conflict(
          'ZONE_ALREADY_IN_AUDIT',
          'This Zone is already part of this audit. A Zone appears at most once per audit.',
        );
      }
      await this.assertZoneNotClaimed(scope, auditId, zoneId);
    }

    // Two refusals a first write can earn, both decided here rather than left to whichever
    // unique index the insert happens to hit first. A later write of a Zone this audit
    // already holds is neither: it is the ordinary upsert, checked against its own row.
    if (!existing) {
      const alreadyInAudit = await this.repository.listZones(scope, auditId);
      if (alreadyInAudit.some((zone) => zone.zoneId === zoneId && zone.status !== 'WITHDRAWN')) {
        throw AppError.conflict(
          'ZONE_ALREADY_IN_AUDIT',
          'This Zone is already part of this audit. A Zone appears at most once per audit.',
        );
      }
      // R-29: a Zone another open audit of this Unit is holding.
      await this.assertZoneNotClaimed(scope, auditId, zoneId);
    }

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

    /**
     * The typed name is written back to the Zone before the snapshot is taken (0015).
     *
     * Order matters. `zone` was read before this, so it still carries the leader as it was;
     * writing first and snapshotting the *result* means the audit records the name the Zone
     * now shows, rather than the two disagreeing by one write.
     *
     * The function refuses silently — a closed audit, someone else's audit, a Zone in
     * another Unit — and a refusal is not an error here. It only means the Zone keeps the
     * leader it had, which is exactly what the snapshot below then records. The audit is
     * never blocked over a display field.
     *
     * Skipped entirely for a walk-by that resolved a real leader account: that path already
     * names a user, and `app_set_zone_leader_name` would decline to overwrite one anyway.
     */
    let zoneLeaderName = zone?.zoneLeaderName ?? null;
    if (!account && request.zoneLeaderName?.trim() && zone) {
      zoneLeaderName = await this.repository.setZoneLeaderName(scope, {
        auditId,
        zoneId,
        name: request.zoneLeaderName,
      });
    }

    const leader = account
      ? { userId: account.id, name: account.fullName }
      : zoneLeaderSnapshot(
          zone ? { zoneLeaderId: zone.zoneLeaderId, zoneLeaderName } : null,
          request.zoneLeaderName,
        );

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
        /*
         * R-34: which snapshot fields this write may re-take.
         *
         * **Only what the auditor actually supplied**, never a blanket refresh from the
         * live `zone` row. That distinction is the whole of D6's remaining guarantee: a
         * Coordinator renaming a Zone in master data must not reach an audit's snapshot,
         * and a blanket re-copy would let it in through the back door the next time the
         * device saved so much as a remark.
         *
         * So: the code and name follow only a deliberate change of Zone number; the
         * description and the leader follow only a request that named one.
         */
        resnapshot: editable
          ? {
              ...(existing && zoneId !== existing.zoneId
                ? {
                    zoneId,
                    zoneCodeSnapshot: snapshot.zoneCodeSnapshot,
                    zoneNameSnapshot: snapshot.zoneNameSnapshot,
                  }
                : {}),
              ...(request.zoneDescription !== undefined
                ? { zoneDescriptionSnapshot: snapshot.zoneDescriptionSnapshot }
                : {}),
              ...(request.zoneLeaderName !== undefined || request.zoneLeaderUserId !== undefined
                ? {
                    zoneLeaderUserIdSnapshot: snapshot.zoneLeaderUserIdSnapshot,
                    zoneLeaderNameSnapshot: snapshot.zoneLeaderNameSnapshot,
                  }
                : {}),
            }
          : {},
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
      // R-29's trigger, or the partial unique index behind it when two devices claimed the
      // Zone in the same instant. Both name the same constraint, so both read the same way.
      if (isUniqueViolation(error, 'audit_zone_claimed_by_open_audit')) {
        throw AppError.conflict(
          'ZONE_LOCKED_BY_ANOTHER_AUDIT',
          'Another audit of this Unit is already covering this Zone. Choose a different ' +
            'Zone; nothing you have recorded is lost.',
        );
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
      /**
       * Idempotent: a retried finish returns the Zone rather than raising.
       *
       * It is not always a *retry*, though, and that is why it rescores. An auditor who
       * reviewed a finished Zone, changed an answer and pressed Submit again sends exactly
       * this item, and the early return used to make it a no-op — leaving the answer
       * changed and the score that everything downstream reads untouched.
       *
       * `recompute` is the same call the real edge below makes and reads the responses as
       * they now stand, so a genuine retry writes back the numbers that are already there.
       * Skipped once the audit itself is finished: those rows are frozen by A-2, and
       * rescoring them is the trigger's refusal rather than a correction.
       */
      if (!isAuditCompleted(audit.status) && audit.status !== 'CANCELLED') {
        await this.scoring.recompute(scope, auditId);
      }
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
   * The auditor's "abort this Zone": an unfinished Zone leaves its audit.
   *
   * Nothing is deleted (A-1). The status moves to WITHDRAWN — which takes the Zone out of
   * the audit's score, out of the Finish-audit guard and out of the findings raised on
   * completion — and 0031's trigger releases its R-29 lock in the same write, so another
   * audit, or this one again, may take the Zone. Its answers and photographs stay on record.
   *
   * Idempotent: a retried withdrawal returns the Zone as it is.
   */
  async withdraw(
    scope: ScopeContext,
    auditZoneId: string,
    request: WithdrawAuditZoneRequest,
  ): Promise<AuditZone> {
    const audit = await this.mustFindAudit(scope, request.auditId);
    const zone = await this.repository.findZone(scope, auditZoneId);
    if (!zone || zone.auditId !== request.auditId) {
      throw AppError.notFound('No such audit Zone on this audit');
    }
    if (zone.status === 'WITHDRAWN') {
      return this.get(scope, auditZoneId);
    }

    this.assertWritable(scope, audit);

    try {
      assertTransition('audit_zone', zone.status, 'WITHDRAWN', {
        role: scope.actor.role,
        satisfied: [],
      });
    } catch (error) {
      if (zone.status === 'COMPLETED') {
        throw AppError.conflict(
          'INVALID_STATE_TRANSITION',
          'This Zone is already finished, so it is part of the audit. Review it instead of withdrawing it.',
        );
      }
      throw asAppError(error);
    }

    await this.repository.updateZone(scope, auditZoneId, {
      status: 'WITHDRAWN',
      withdrawnAt: request.withdrawnAt ? new Date(request.withdrawnAt) : new Date(),
      withdrawReason: request.reason ?? null,
      resumeQuestionId: null,
      clientUpdatedAt: new Date(),
    });

    await this.auditLog.record({
      action: 'audit_zone.withdrawn',
      resourceType: 'audit_zone',
      resourceId: auditZoneId,
      unitId: audit.unitId,
      before: { status: zone.status },
      after: { status: 'WITHDRAWN', reason: request.reason ?? null },
    });

    // The audit's score no longer includes this Zone.
    await this.scoring.recompute(scope, request.auditId);

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
   * R-29: one Zone, one open audit.
   *
   * A Unit assigned to two Consultants (R-28) can have two audits running on one morning,
   * and before this the schema let both of them cover Zone 1 — two independent scores for
   * one Zone on one day, which a report cannot render as anything but a duplicate.
   *
   * The refusal names the auditor holding it, because the auditor reading it is standing
   * in a plant and the useful next step is to walk to a different Zone, or to ask the
   * colleague whose name this is. The database refuses it either way; this is the sentence
   * that makes the refusal actionable rather than mysterious.
   */
  private async assertZoneNotClaimed(
    scope: ScopeContext,
    auditId: string,
    zoneId: string,
  ): Promise<void> {
    const holder = await this.repository.zoneClaimedByOtherAudit(scope, zoneId, auditId);
    if (!holder) {
      return;
    }

    const locks = await this.repository.listZoneLocks(scope, auditId);
    const lock = locks.find((candidate) => candidate.zoneId === zoneId);

    throw AppError.conflict(
      'ZONE_LOCKED_BY_ANOTHER_AUDIT',
      lock
        ? `Zone ${lock.zoneCode} — ${lock.zoneName} is already being audited by ` +
          `${lock.auditorName} in another audit of this Unit. Choose a different Zone; ` +
          'nothing you have recorded is lost.'
        : 'Another audit of this Unit is already covering this Zone. Choose a different ' +
          'Zone; nothing you have recorded is lost.',
    );
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
