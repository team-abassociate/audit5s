-- =============================================================================
-- 0028 — An auditor may restart their own finished audit, twice (DECISIONS.md R-33)
--
-- A Consultant tapped *Finish audit* by mistake and had no way back: §7.1 had no edge out
-- of `COMPLETED`, so a slip of the thumb ended the audit and froze its score.
--
-- This migration adds the counter and nothing else, which is the point worth stating. The
-- restart is a change to a completed audit, so it goes through **A-2's existing door** —
-- the override transaction R-30 opened, which `app_post_completion_override()` (0022)
-- already admits the auditor of the named audit through. No new carve-out is cut, the
-- append-only trigger is untouched, and a restart that did not set the override flag is
-- refused by `enforce_completed_audit_append_only` exactly as a stray UPDATE would be.
--
-- The cap lives here as a CHECK as well as in the service, for the usual reason: the
-- service enforces it so the user gets `RESTART_LIMIT_REACHED` rather than a 500, and the
-- constraint enforces it so a bug in the service cannot produce a fourth restart. Two
-- restarts means `restart_count` reaches 2, never 3.
--
-- Backfill is `0`: every audit that exists has been restarted no times, which is both true
-- and the value a `NOT NULL DEFAULT 0` gives them without rewriting the table's meaning.
-- =============================================================================

ALTER TABLE audit
  ADD COLUMN restart_count integer NOT NULL DEFAULT 0;

ALTER TABLE audit
  ADD CONSTRAINT audit_restart_count_capped CHECK (restart_count BETWEEN 0 AND 2);

COMMENT ON COLUMN audit.restart_count IS
  'R-33: restarts after completion, capped at two. Written only inside an override '
  'transaction, which writes an audit.restarted log entry beside it.';
