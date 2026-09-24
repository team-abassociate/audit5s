import { Injectable, Logger } from '@nestjs/common';
import type { QuestionResponse, UpsertQuestionResponseRequest } from '@audit5s/contracts';
import { assertTransition, isAuditCompleted, numericScoreFor, type ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { asAppError } from '../audit-assignments/assignments.service';
import { AuditsRepository } from '../audits/audits.repository';
import { ScoringService } from '../audits/scoring.service';
import { toQuestionResponse } from '../audits/audits.service';
import { EvidenceService } from '../evidence/evidence.service';

/**
 * Question responses (§8.6).
 *
 * This is the hottest write in the system: fifty of these per Zone, each one a device
 * committing a single answer. Three properties make a retry harmless, which matters
 * because a device on a factory floor retries constantly:
 *
 *   - `UNIQUE(audit_zone_id, checklist_question_id)` means a resend lands on the same row
 *     whatever id the client generated. Five copies of one payload leave one row.
 *   - `numericScore` is derived here from `value` through `packages/domain`, so QR-1's
 *     CHECK can never be tripped by a client that disagrees with it.
 *   - The audit Zone's `DRAFT → IN_PROGRESS` edge fires on the first response, so the
 *     status follows the data rather than needing a separate call the device might lose.
 */
@Injectable()
export class ResponsesService {
  private readonly logger = new Logger(ResponsesService.name);

  constructor(
    private readonly repository: AuditsRepository,
    private readonly evidence: EvidenceService,
    private readonly scoring: ScoringService,
  ) {}

  async upsert(
    scope: ScopeContext,
    auditZoneId: string,
    responseId: string,
    request: UpsertQuestionResponseRequest,
  ): Promise<QuestionResponse> {
    const zone = await this.repository.findZone(scope, auditZoneId);
    if (!zone) {
      throw AppError.notFound('No such audit Zone');
    }

    if (isAuditCompleted(zone.auditStatus)) {
      // PART 6's condition on `question_response:upsert`, and A-2's application half.
      throw AppError.conflict(
        'AUDIT_ALREADY_COMPLETED',
        'This audit is completed. Use the post-completion override, which is audit-logged (A-2).',
      );
    }
    if (zone.auditStatus === 'CANCELLED') {
      throw AppError.conflict('INVALID_STATE_TRANSITION', 'This audit was cancelled');
    }
    if (zone.status === 'WITHDRAWN') {
      throw AppError.conflict(
        'INVALID_STATE_TRANSITION',
        'This Zone was withdrawn from the audit. Start the Zone again to record answers for it.',
      );
    }

    if (scope.actor.deviceId && zone.owningDeviceId && zone.owningDeviceId !== scope.actor.deviceId) {
      throw AppError.conflict(
        'DEVICE_NOT_OWNER',
        'Another device is conducting this audit. It must finish or abort it first (D7).',
      );
    }

    if (!zone.checklistVersionId) {
      throw AppError.validation('This audit Zone has no checklist version pinned to it', [
        { field: 'checklistQuestionId', message: 'The Zone was added without a checklist version' },
      ]);
    }

    // Invariant QR-2: the question must belong to the Zone's **pinned** version. The join
    // is the check — a question from any other version simply is not found, so a
    // republish mid-audit cannot mix two versions into one Zone.
    const question = await this.repository.findQuestionInVersion(
      scope,
      request.checklistQuestionId,
      zone.checklistVersionId,
    );
    if (!question) {
      throw AppError.conflict(
        'CHECKLIST_VERSION_MISMATCH',
        'That question does not belong to the checklist version pinned to this Zone (QR-2)',
      );
    }

    if (request.value === 'NA' && !question.allowsNa) {
      throw AppError.validation('This question may not be answered NA', [
        { field: 'value', message: 'NA is not permitted for this question' },
      ]);
    }

    const clientUpdatedAt = request.clientUpdatedAt
      ? new Date(request.clientUpdatedAt)
      : new Date(request.answeredAt);

    const storedId = await this.repository.upsertResponse(scope, {
      id: responseId,
      auditZoneId,
      auditId: zone.auditId,
      checklistQuestionId: request.checklistQuestionId,
      section: question.section,
      globalOrder: question.globalOrder,
      value: request.value,
      // Derived, never accepted from the client: QR-1 is a CHECK, so a disagreeing client
      // would simply be refused by the database with an error it could not act on.
      numericScore: numericScoreFor(request.value),
      remark: request.remark,
      answeredAt: new Date(request.answeredAt),
      clientUpdatedAt,
    });

    if (zone.status === 'DRAFT') {
      try {
        assertTransition('audit_zone', 'DRAFT', 'IN_PROGRESS', {
          role: scope.actor.role,
          satisfied: ['device_owns_audit'],
        });
      } catch (error) {
        throw asAppError(error);
      }
      await this.repository.updateZone(scope, auditZoneId, {
        status: 'IN_PROGRESS',
        startedAt: new Date(request.answeredAt),
        clientUpdatedAt,
      });
    }

    // The resume cursor follows the last answer, so an abort a moment later resumes at the
    // question the auditor was actually on (§9.8).
    await this.repository.updateZone(scope, auditZoneId, {
      resumeQuestionId: request.checklistQuestionId,
      clientUpdatedAt,
    });

    // Invariant E-2: a photograph attached to this question is reclassified to match the
    // answer as it now stands. §5.6 gives the reason in one line — "otherwise a photo
    // silently misfiles into the wrong report section" — and a NONCONFORMITY filed as a
    // GOOD is a corrective action nobody is ever asked to close.
    const reclassified = await this.evidence.reclassifyForResponse(scope, storedId, request.value);
    if (reclassified > 0) {
      this.logger.log(
        `response ${storedId} changed to ${request.value}: reclassified ${reclassified} photo(s) (E-2)`,
      );
    }

    /**
     * Revising a Zone that is already finished rescores the audit here.
     *
     * PART 6 permits this write until the **audit** is completed — "device owner; audit
     * must not be COMPLETED" — so an auditor may reopen a finished Zone from the Review
     * button and change an answer. The materialised scores were written on that Zone's
     * completion edge, and that edge does not fire twice: without this, the answer changed
     * and `audit_zone.score_percentage`, its five `audit_zone_section_score` rows and
     * `audit.total_score` all kept the figure from before the review.
     *
     * Every downstream reader takes those columns — the Unit board, analytics and the PDF
     * — so the effect was an audit whose answers and whose score disagreed everywhere
     * except `GET /audits/{id}/summary`, which recomputes. The scorer is the same pure
     * function on both sides of that disagreement, so there was never a second opinion to
     * reconcile: one of the two was simply stale.
     *
     * Only for a Zone already COMPLETED. While it is IN_PROGRESS the scores are not
     * written yet, and recomputing on all fifty answers would be forty-nine writes of a
     * number nothing reads.
     */
    if (zone.status === 'COMPLETED') {
      await this.scoring.recompute(scope, zone.auditId);
    }

    const responses = await this.repository.listResponses(scope, zone.auditId);
    const stored = responses.find((response) => response.id === storedId);
    if (!stored) {
      throw AppError.internal('The response was written but could not be read back');
    }
    return toQuestionResponse(stored);
  }
}
