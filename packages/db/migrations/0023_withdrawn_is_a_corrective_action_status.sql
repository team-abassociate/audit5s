-- =============================================================================
-- 0023 — `WITHDRAWN` joins the corrective-action statuses (DECISIONS.md R-31)
--
-- **This migration adds the enum label and nothing else, on purpose.**
--
-- `ALTER TYPE ... ADD VALUE` may run inside a transaction on PostgreSQL 12 and later, but
-- the new label cannot be *used* until that transaction commits — a CHECK constraint or an
-- UPDATE naming it in the same transaction is refused with "unsafe use of new value of enum
-- type". The migration runner gives each file its own transaction, so the split into 0023
-- and 0024 is what makes the label usable by the time anything reaches for it.
--
-- What the label means is in 0024, beside the constraint that gives it teeth.
-- =============================================================================

ALTER TYPE corrective_action_status ADD VALUE IF NOT EXISTS 'WITHDRAWN';
