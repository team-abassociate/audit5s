-- =============================================================================
-- 0046 — A Kaizen records what it cost to implement
--
-- Owner, 2026-10-11. Additive only: one nullable column. The release before this one runs
-- unchanged on it: nothing it writes sets `implementation_cost`.
--
-- Zero is an answer (the Kaizen cost nothing) and is kept apart from NULL (not stated).
-- No upper bound beyond the column's own, as `annual_saving` (0044).
-- =============================================================================

ALTER TABLE kaizen ADD COLUMN implementation_cost numeric(14,2) CHECK (implementation_cost >= 0);
