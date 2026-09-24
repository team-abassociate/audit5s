-- =============================================================================
-- 0030 — WITHDRAWN is an audit Zone status
--
-- An auditor standing in a Zone must be able to abandon it — the wrong Zone, a line that
-- stopped, a leader who is not there — without abandoning the whole audit. Until now the
-- only way out of a started Zone was to finish it, and an unfinished Zone blocked
-- *Finish audit* for good.
--
-- The value is added here, alone, because Postgres will not let a transaction use an enum
-- value it added itself, and the migration runner gives every file one transaction. 0031
-- puts it to use.
-- =============================================================================

ALTER TYPE audit_zone_status ADD VALUE IF NOT EXISTS 'WITHDRAWN';
