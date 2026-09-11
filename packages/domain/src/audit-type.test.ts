import { describe, expect, it } from 'vitest';
import { AUDIT_TYPES } from '@audit5s/contracts';
import {
  SCORED_AUDIT_TYPES,
  auditTypeRequiresZonePhoto,
  auditTypeUsesChecklist,
  isScoredAuditType,
} from './audit-type';

describe('audit types (§2.5–§2.7)', () => {
  it('scores the two questionnaire types and not the walk-by', () => {
    expect(isScoredAuditType('EXTERNAL_5S')).toBe(true);
    expect(isScoredAuditType('CROSS_5S')).toBe(true);
    expect(isScoredAuditType('WALK_BY')).toBe(false);
  });

  it('covers every audit type in the enum', () => {
    // A fourth type added to `AUDIT_TYPES` must be decided here, not defaulted. The
    // predicate would answer `false` silently, which is the wrong default for a type that
    // does have a questionnaire.
    const decided = new Set<string>([...SCORED_AUDIT_TYPES, 'WALK_BY']);
    expect([...AUDIT_TYPES].filter((type) => !decided.has(type))).toEqual([]);
  });

  it('ties the checklist to scoring, as §5.5 does', () => {
    // §5.5: `checklist_version_id` is "Null for WALK_BY".
    expect(auditTypeUsesChecklist('EXTERNAL_5S')).toBe(true);
    expect(auditTypeUsesChecklist('WALK_BY')).toBe(false);
  });

  it('requires a photograph per Zone only where there are no answers', () => {
    // §7.2's guard table: the two forms of `IN_PROGRESS → COMPLETED` are alternatives.
    expect(auditTypeRequiresZonePhoto('WALK_BY')).toBe(true);
    expect(auditTypeRequiresZonePhoto('CROSS_5S')).toBe(false);
    for (const type of AUDIT_TYPES) {
      expect(auditTypeRequiresZonePhoto(type)).toBe(!isScoredAuditType(type));
    }
  });
});
