import { type AuditType } from '@audit5s/contracts';

/**
 * What an audit type does and does not have (ARCHITECTURE.md §2.5–§2.7).
 *
 * §2.7 opens with four words — "No questionnaire, no score" — and those four words are a
 * rule three layers have to agree about: the API must not write a percentage for a walk-by,
 * the reports must not render one, and PART 11's score metrics must exclude it
 * ("Walk-by audits are excluded from every score metric"). Deriving that from
 * `auditType === 'WALK_BY'` at each of those sites is three copies of one decision; this is
 * the one copy, and it is a predicate rather than an inequality so a fourth audit type
 * would be a change here and nowhere else.
 */

/** The types that carry a questionnaire, and therefore a score. */
export const SCORED_AUDIT_TYPES = ['EXTERNAL_5S', 'CROSS_5S'] as const satisfies readonly AuditType[];

export type ScoredAuditType = (typeof SCORED_AUDIT_TYPES)[number];

/**
 * True when this type answers questions and has marks.
 *
 * The name is deliberately about scoring rather than about walk-bys: the callers that
 * matter — the recompute, the summary, the analytics filter — care whether there is a
 * number, not which type is missing one.
 */
export function isScoredAuditType(auditType: AuditType): auditType is ScoredAuditType {
  return (SCORED_AUDIT_TYPES as readonly AuditType[]).includes(auditType);
}

/**
 * Whether a `checklist_version_id` may be pinned.
 *
 * §5.5 says the column is "Null for `WALK_BY`", and §7.1's `READY → IN_PROGRESS` guard asks
 * for "published checklist version exists (non-walk-by)". Both are the same fact, so both
 * read it from here. Migration 0008 states it a third time as a CHECK — not redundancy but
 * depth: this refuses it with a message, the constraint refuses it at all.
 */
export function auditTypeUsesChecklist(auditType: AuditType): boolean {
  return isScoredAuditType(auditType);
}

/**
 * Whether each Zone of this audit needs at least one photograph to be finished.
 *
 * §7.2's guard table gives `IN_PROGRESS → COMPLETED` two forms and this is which one
 * applies: a walk-by Zone completes on "≥1 non-deleted evidence row" — the "minimum one
 * live photo per Zone" rule — because it has no answers to have finished instead.
 */
export function auditTypeRequiresZonePhoto(auditType: AuditType): boolean {
  return auditType === 'WALK_BY';
}
