import type { AuditStatus, CorrectiveActionStatus, CorrectiveOption } from '@audit5s/contracts';
import { AUDIT_TRANSITIONS, type Transition } from './state-machine';

/**
 * Corrective-action rules that are pure (ARCHITECTURE.md §2.8, §7.1, §7.3).
 *
 * The audit rollup reads "resolved" as §5.7 defines `resolved_at`: VERIFIED, which is also
 * how an accepted NOT_POSSIBLE ends (§7.3). A submission awaiting review has not resolved
 * anything, so it does not move the audit (DECISIONS.md R-13).
 */

export type RollupStatus = 'CORRECTIVE_ACTION_OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED';

/** §2.8: open while none is resolved, partially closed while some are, closed when all are. */
export function rollupAuditStatus(actions: readonly CorrectiveActionStatus[]): RollupStatus {
  const verified = actions.filter((status) => status === 'VERIFIED').length;
  if (verified === actions.length) return 'CLOSED';
  return verified > 0 ? 'PARTIALLY_CLOSED' : 'CORRECTIVE_ACTION_OPEN';
}

export const COMPLETED_AUDIT_STATUSES: readonly AuditStatus[] = [
  'COMPLETED',
  'CORRECTIVE_ACTION_OPEN',
  'PARTIALLY_CLOSED',
  'CLOSED',
];

/**
 * At or past COMPLETED. Once corrective actions materialise an audit rarely *rests* on
 * COMPLETED, so "is it completed" is never `status === 'COMPLETED'`.
 */
export function isAuditCompleted(status: string): boolean {
  return (COMPLETED_AUDIT_STATUSES as readonly string[]).includes(status);
}

const ROLLUP_EDGES = AUDIT_TRANSITIONS.filter(
  (edge) =>
    COMPLETED_AUDIT_STATUSES.includes(edge.from) && COMPLETED_AUDIT_STATUSES.includes(edge.to),
);

/**
 * The §7.1 edges that take an audit from `from` to `to`, shortest first; `[]` when it is
 * already there and `null` when no path exists.
 *
 * A path rather than a jump because the table has no direct edge for every move: a
 * single-action audit that was CLOSED and has its action reopened goes
 * `CLOSED → PARTIALLY_CLOSED → CORRECTIVE_ACTION_OPEN`, and each step is asserted on its
 * own so the state machine stays the only thing that moves a status.
 */
export function rollupPath(from: AuditStatus, to: RollupStatus): Transition<AuditStatus>[] | null {
  if (from === to) return [];
  if (!COMPLETED_AUDIT_STATUSES.includes(from)) return null;

  const queue: Array<{ at: AuditStatus; path: Transition<AuditStatus>[] }> = [{ at: from, path: [] }];
  const seen = new Set<AuditStatus>([from]);

  while (queue.length > 0) {
    const { at, path } = queue.shift()!;
    for (const edge of ROLLUP_EDGES) {
      if (edge.from !== at || seen.has(edge.to)) continue;
      const next = [...path, edge];
      if (edge.to === to) return next;
      seen.add(edge.to);
      queue.push({ at: edge.to, path: next });
    }
  }
  return null;
}

/** Option A lands on ACTION_SUBMITTED, Option B on NOT_POSSIBLE (§7.3). */
export function submissionTarget(option: CorrectiveOption): CorrectiveActionStatus {
  return option === 'COMPLETED' ? 'ACTION_SUBMITTED' : 'NOT_POSSIBLE';
}

/** The Zone Leader's to-do: nothing submitted yet, or sent back. */
export function awaitsResponse(status: CorrectiveActionStatus): boolean {
  return status === 'OPEN' || status === 'REOPENED';
}

/** The Super Admin's to-do: an attempt waiting to be verified or reopened. */
export function awaitsReview(status: CorrectiveActionStatus): boolean {
  return status === 'ACTION_SUBMITTED' || status === 'NOT_POSSIBLE';
}

export function isOverdue(
  status: CorrectiveActionStatus,
  dueAt: string | null,
  nowMs: number,
): boolean {
  return awaitsResponse(status) && dueAt !== null && Date.parse(dueAt) < nowMs;
}
