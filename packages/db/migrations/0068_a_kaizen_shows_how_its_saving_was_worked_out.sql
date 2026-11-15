-- =============================================================================
-- 0068 — A Kaizen shows how its saving was worked out
--
-- Owner, 2026-11-15. The savings calculator fills the annual saving and the cost to
-- implement; this keeps its lines (so the leader can reopen them) and its working as
-- printed (so a reviewer sees the steps). Shape: packages/contracts `kaizenSavingCalcSchema`.
--
-- Additive only: one nullable column. The release before this one runs unchanged on it:
-- nothing it writes sets `saving_calc`. NULL is "typed by hand, no working".
-- (0066 and 0067 are taken by open branches.)
-- =============================================================================

ALTER TABLE kaizen ADD COLUMN saving_calc jsonb CHECK (saving_calc IS NULL OR jsonb_typeof(saving_calc) = 'object');
