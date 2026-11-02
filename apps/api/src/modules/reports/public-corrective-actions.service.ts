import { Injectable } from '@nestjs/common';
import type {
  CorrectiveActionSubmission,
  PublicCorrectiveAction,
  UploadIntentResponse,
} from '@audit5s/contracts';
import { type ScopeContext, type SignedTokenScope } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { scopeFor } from '../../common/auth/scope-for';
import { CorrectiveActionsService } from '../corrective-actions/corrective-actions.service';
import { CorrectiveActionsRepository } from '../corrective-actions/corrective-actions.repository';
import { EvidenceService } from '../evidence/evidence.service';

type ResolvedToken = SignedTokenScope & { issuedToName: string | null };

/**
 * What the live corrective-action page can do (§10.4).
 *
 * It is a thin composition over services that already exist, and that is the design rather
 * than laziness: §8.8 requires the public submission to use **the same domain service** as
 * the authenticated route, so CA-1's append-only attempts, CA-2's after-photo rule and
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
    // An overall action (R-38) has no before photo: it answers a sentence, not a picture.
    const before = await this.repository.findById(scope, token.correctiveActionId);
    const beforePhotoUrl = before?.evidenceId
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
      suggestion: detail.suggestion,
      dueAt: detail.dueAt,
      beforePhotoUrl,
      // Only an item waiting for an answer takes one. A response awaiting review (or a
      // verified item) is shown read-only, rather than as a form whose photo upload the
      // evidence service refuses a moment later — which the page reported as "could not
      // reach the server".
      // R-78: a link reads the item but no longer answers it — the Zone's leader does, in the app.
      submittable: false,
      issuedToName: token.issuedToName,
      alreadySubmitted: latest
        ? { option: latest.option, submittedAt: latest.createdAt }
        : null,
    };
  }

  /** R-78: a link reads the item and answers nothing; the routes stay so old pages are told why. */
  createUploadIntent(): Promise<UploadIntentResponse> {
    return Promise.reject(linkAnswersNothing());
  }

  submit(): Promise<CorrectiveActionSubmission> {
    return Promise.reject(linkAnswersNothing());
  }

  private async presignBeforePhoto(
    scope: ScopeContext,
    evidenceId: string,
  ): Promise<string | null> {
    try {
      const view = await this.evidence.viewUrl(
        scopeFor(scope, 'evidence:view_url'),
        evidenceId,
        'original',
      );
      return view.url;
    } catch {
      // A redacted or missing photograph must not take the page down: the Zone Leader can
      // still read the finding and answer it, which is the point of the page.
      return null;
    }
  }
}

/** R-78: only the Zone's leader (or the Coordinator, or a Super Admin) closes it, in the app. */
function linkAnswersNothing(): AppError {
  return AppError.forbidden(
    'FORBIDDEN',
    "A link no longer answers a nonconformity. The Zone's leader closes it in the Leanstack app.",
  );
}
