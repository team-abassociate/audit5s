import { Injectable } from '@nestjs/common';
import type { ScopeContext } from '@audit5s/domain';
import { EvidenceRepository } from '../evidence/evidence.repository';

/**
 * The `selfie_captured` guard on `ASSIGNED → READY` (§7.1).
 *
 * Phase 3 left this as a seam with a named constant, because `evidence` did not exist and
 * a guard requiring a row that could not exist would refuse every start (DECISIONS.md
 * R-8c). Phase 4 creates the table, so the guard is now what §7.1 always said it was: an
 * `AUDITOR_SELFIE` row that belongs to this audit, is live-captured, and has not been
 * deleted.
 *
 * `is_live_capture` is part of the check because §2.3 and §12.10 put the selfie there as
 * evidence of attendance, and a gallery image is not that. §12.10 is equally clear about
 * what the check is worth: a modified build can set the flag, so this is deterrence plus
 * evidence, not prevention. It is enforced anyway, because the cost of enforcing it is one
 * predicate and the cost of not enforcing it is a flow that quietly permits the thing it
 * was designed to prevent.
 *
 * The upload need not have **completed**. A selfie whose bytes are still in the media
 * queue is a captured selfie: §9.1 makes SQLite the source of truth while an audit is in
 * progress, and blocking a start on an upload would put the network back in the path of
 * the questionnaire, which is the one thing Phase 3 established it must never be in.
 */
@Injectable()
export class SelfieRequirement {
  constructor(private readonly evidence: EvidenceRepository) {}

  async isSatisfied(
    scope: ScopeContext,
    selfieEvidenceId: string | null,
    auditId?: string,
  ): Promise<boolean> {
    // Before the audit row exists — the creation path — there is nothing to join against,
    // so the id itself is what the caller has. The foreign key added in migration 0007
    // refuses an id that names nothing, which is the check that matters there.
    if (!auditId) {
      return selfieEvidenceId !== null;
    }

    // Looked up **by audit** rather than only by the pointer. The selfie is captured after
    // the audit row exists — `evidence.audit_id` is a foreign key, so it has to be — and
    // committing it is what sets the pointer. A guard that read only the pointer would
    // refuse an audit whose selfie is sitting in the device's media queue, which is the
    // normal offline case and not a failure.
    const selfie = await this.evidence.findSelfieForAudit(scope, auditId);
    return selfie !== null && selfie.isLiveCapture;
  }
}

/**
 * Phase 3's seam constant, now true.
 *
 * Kept rather than deleted: it is referenced by the Phase 3 handoff and by anyone grepping
 * for what the flip changed, and a constant that says "this is enforced" is cheaper to
 * read than the absence of one.
 */
export const EVIDENCE_ENFORCED = true;
