-- =============================================================================
-- 0061 — `TREND_SUMMARY` joins the report kinds: a summary of summaries
--
-- **This migration adds the enum label and nothing else, on purpose** — the reason 0023
-- gives: a label added in a transaction cannot be used until it commits, and the runner
-- gives each file its own. What the kind means is in 0062.
-- =============================================================================

ALTER TYPE report_kind ADD VALUE IF NOT EXISTS 'TREND_SUMMARY';
