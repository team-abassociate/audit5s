-- =============================================================================
-- 0069 — A Kaizen has a target date of its own
--
-- Owner, 2026-11-24. The sheet's "Target & target date" was one free-text box; the date is
-- now picked from a calendar, so it gets its own column. Both stay optional.
--
-- Additive only: one nullable column. The release before this one runs unchanged on it:
-- nothing it writes sets `target_date`. Existing Kaizens keep whatever date they typed into
-- `target`; nothing is moved out of the text.
-- =============================================================================

ALTER TABLE kaizen ADD COLUMN target_date date;
