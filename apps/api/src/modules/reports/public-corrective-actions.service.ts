import { Injectable } from '@nestjs/common';
import type {
  CorrectiveActionSubmission,
  PublicCorrectiveAction,
  SubmitCorrectiveActionRequest,
  UploadIntentRequest,
  UploadIntentResponse,
} from '@audit5s/contracts';
import type { ScopeContext, SignedTokenScope } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { CorrectiveActionsService } from '../corrective-actions/corrective-actions.service';
import { CorrectiveActionsRepository } from '../corrective-actions/corrective-actions.repository';
import { EvidenceService } from '../evidence/evidence.service';

type ResolvedToken = SignedTokenScope & { issuedToName: string | null };

/**
 * What the live corrective-action page can do (§10.4).
 *
 * It is a thin composition over services that already exist, and that is the design rather
 * than laziness: §8.8 requires the public submission to use **the same domain service** as
 * the authenticated route, so CA-1's append-only attempts, CA-2's live-capture rule and
 * the audit rollup have one implementation. A parallel "public" implementation would be
 * two sets of rules that are supposed to agree, on the one surface where being wrong is
 * most expensive.
 *
 * What this class adds is the narrowing: every method re-checks that the thing being acted
 * on is the single item the token names, on top of the scope predicate the resolver has
 * already applied. Belt and braces, because the cost of being wrong here is a stranger
 * reading another Unit's findings.
 */
@Injectable()
export class PublicCorrectiveActionsService {
  constructor(
    private readonly actions: CorrectiveActionsService,
    private readonly repository: CorrectiveActionsRepository,
    private readonly evidence: EvidenceService,
  ) {}

  async get(scope: ScopeContext, token: ResolvedToken): Promise<PublicCorrectiveAction> {
    const detail = await this.actions.get(scope, token.correctiveActionId);

    // The before photo, through a short-TTL presigned GET minted after the token check
    // (§12.6). Never a stored URL: the page holds a link that expires in minutes.
    const before = await this.repository.findById(scope, token.correctiveActionId);
    const beforePhotoUrl = before
      ? await this.presignBeforePhoto(scope, before.evidenceId)
      : null;

    const latest = detail.submissions.at(-1) ?? null;
    const context = await this.repository.findPublicContext(scope, token.correctiveActionId);

    return {
      correctiveActionId: detail.id,
      status: detail.status,
      unitName: context?.unitName ?? '',
      zoneCode: detail.zoneCode,
      zoneName: detail.zoneName,
      auditDate: detail.auditCompletedAt,
      auditorName: context?.auditorName ?? '',
      questionGlobalOrder: detail.questionGlobalOrder,
      questionText: detail.questionText,
      section: detail.section,
      findingRemark: detail.findingRemark,
      dueAt: detail.dueAt,
      beforePhotoUrl,
      // A verified item is finished. The page shows what was submitted, read-only, rather
      // than a form that would be refused by `assertTransition` a moment later.
      submittable: detail.status !== 'VERIFIED',
      issuedToName: token.issuedToName,
      alreadySubmitted: latest
        ? { option: latest.option, submittedAt: latest.createdAt }
        : null,
    };
  }

  /**
   * The after-photo's presigned PUT.
   *
   * Three fields are **overwritten from the token**, not taken from the body: the kind,
   * the corrective action and the audit. A public page that could name its own action
   * would make the single-item audience a suggestion.
   */
  async createUploadIntent(
    scope: ScopeContext,
    token: ResolvedToken,
    request: UploadIntentRequest,
  ): Promise<UploadIntentResponse> {
    const action = await this.repository.findById(scope, token.correctiveActionId);
    if (!action) throw AppError.notFound('No such corrective action');

    if (!request.isLiveCapture) {
      // CA-2 and §10.4. The page uses `getUserMedia` and offers no file picker; this is
      // the server saying so too, because a client-side rule is a client-side rule.
      throw AppError.validation('The after-photo must be a live capture', [
        { field: 'isLiveCapture', message: 'Option A requires a live camera capture (CA-2)' },
      ]);
    }

    return this.evidence.createUploadIntent(scope, {
      ...request,
      kind: 'CORRECTIVE_AFTER',
      auditId: action.auditId,
      auditZoneId: action.auditZoneId,
      correctiveActionId: token.correctiveActionId,
      questionResponseId: undefined,
      classification: undefined,
    });
  }

  /** The same service the authenticated route calls, with the link recorded on the row. */
  async submit(
    scope: ScopeContext,
    token: ResolvedToken,
    request: SubmitCorrectiveActionRequest,
  ): Promise<CorrectiveActionSubmission> {
    return this.actions.submit(scope, token.correctiveActionId, request, 'WEB_TOKEN', token.tokenId);
  }

  private async presignBeforePhoto(
    scope: ScopeContext,
    evidenceId: string,
  ): Promise<string | null> {
    try {
      const view = await this.evidence.viewUrl(scope, evidenceId, 'original');
      return view.url;
    } catch {
      // A redacted or missing photograph must not take the page down: the Zone Leader can
      // still read the finding and answer it, which is the point of the page.
      return null;
    }
  }
}
