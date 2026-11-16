-- =============================================================================
-- 0066 — A checklist may hold any number of questions per S, plus a Safety section
--
-- Owner, 2026-11-16: the 5 × 10 shape is no longer required. A department's checklist may
-- have any number of questions in each S, and a Safety section follows 5S. Safety is
-- scored like any S and counts toward the audit's total. Published versions keep the
-- questions they were published with; nothing already stored changes.
--
-- `questions_per_section` stays for older devices that still read it; it now records the
-- largest section's count and constrains nothing.
-- =============================================================================

ALTER TYPE s_section ADD VALUE IF NOT EXISTS 'SAFETY' AFTER 'S5_SUSTAIN';

ALTER TABLE checklist_version DROP CONSTRAINT checklist_version_shape;
ALTER TABLE checklist_version
  ADD CONSTRAINT checklist_version_shape CHECK (total_questions > 0 AND questions_per_section > 0);
