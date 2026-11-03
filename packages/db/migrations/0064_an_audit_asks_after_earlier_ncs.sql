-- =============================================================================
-- 0064 — The auditor answers "Are the earlier NCs closed by the Zone Leader?" (R-79)
--
-- Owner, 2026-11-02: after the fifty questions the auditor is asked whether the Zone's
-- earlier nonconformities were closed by its leader, and answers in words. It is printed in
-- the Zone report. Nullable: every audit before this, and a walk-by, has none.
-- =============================================================================

ALTER TABLE audit_zone ADD COLUMN previous_ncs_answer text;
