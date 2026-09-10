import { Injectable } from '@nestjs/common';
import type { ScopeContext } from '@audit5s/domain';

/**
 * The `selfie_captured` guard on `ASSIGNED → READY` (§7.1), as a seam.
 *
 * The guard is real from the first day; what it can *observe* is not. The `evidence` table
 * arrives with the camera work in Phase 4, so today there is no row a selfie could be and
 * `audit.selfie_evidence_id` has no foreign key to point at. A guard written to require a
 * row that cannot exist would refuse every start, and one quietly deleted would have to be
 * remembered back into existence three phases later.
 *
 * So it is a class with one method, in the shape `ObjectStorage` and
 * `zone_has_in_progress_audit()` already use in this codebase: Phase 4 replaces this
 * implementation with one that reads `evidence`, and every caller stays as it is.
 */
@Injectable()
export class SelfieRequirement {
  /**
   * Whether the selfie precondition is met.
   *
   * Phase 4 makes this "an `AUDITOR_SELFIE` evidence row exists, is live-captured and
   * belongs to this audit". Until the evidence table exists there is nothing to read, and
   * the honest answer is that the requirement is not yet enforced — stated here once
   * rather than as a scattered `// TODO` at each call site.
   */
  isSatisfied(_scope: ScopeContext, selfieEvidenceId: string | null): Promise<boolean> {
    if (selfieEvidenceId !== null) {
      return Promise.resolve(true);
    }
    return Promise.resolve(!EVIDENCE_ENFORCED);
  }
}

/**
 * Flipped to `true` by the Phase 4 migration and module that create `evidence`, together
 * with the real lookup above. Named rather than implicit so a grep for it finds the whole
 * of what Phase 4 has to change here.
 */
export const EVIDENCE_ENFORCED = false;
