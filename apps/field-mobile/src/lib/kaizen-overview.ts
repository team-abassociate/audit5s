import type { KaizenStatus } from '@audit5s/contracts';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A leader's Overview, split the way each heading says (plans/kaizen-ux-plan.md 1.3):
 * "Last 30 days" counts what was submitted in that window and what of it was approved;
 * "Now" counts what is waiting on the Coordinator and what is waiting on the leader,
 * whenever it was submitted. A rejected Kaizen is final, so it needs nobody: History only.
 */
export function groupLeaderKaizens<K extends { status: KaizenStatus; submittedAt: string | null }>(
  all: readonly K[],
  now: number,
) {
  const since = now - THIRTY_DAYS_MS;
  const recent = all.filter((k) => k.submittedAt !== null && Date.parse(k.submittedAt) >= since);
  return {
    recent,
    approved: recent.filter((k) => k.status === 'APPROVED'),
    needsFix: all.filter((k) => k.status === 'SENT_BACK'),
    drafts: all.filter((k) => k.status === 'DRAFT'),
    waiting: all.filter((k) => k.status === 'SUBMITTED'),
  };
}
