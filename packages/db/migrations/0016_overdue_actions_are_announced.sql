-- =============================================================================
-- 0016 — An overdue action announces itself
--
-- A corrective action passing its due date was a fact the database knew and nobody was
-- told. The web dashboard showed it to whoever happened to open the page; the Zone Leader
-- who owns the work, and who is not a web user, found out when someone chased them.
--
-- The nightly per-Unit maintenance tick now raises `CORRECTIVE_ACTION_OVERDUE`. This
-- column is what stops it raising the same one every night until the work is done — a
-- reminder that repeats nightly is a reminder people filter.
--
-- It is deliberately a *notified* marker and not an *is overdue* flag. Whether an action
-- is overdue is `status IN ('OPEN','REOPENED') AND due_at < now()`, which is derivable at
-- any moment and must stay that way (`isOverdue` in `packages/domain` is the one
-- definition). This column records only that we have said so.
--
-- Cleared on reopen: a reopened action gets a fresh due date, so it must be able to fall
-- overdue again and be announced again. That happens in the service, beside the status
-- change, rather than here — one write, one transaction.
-- =============================================================================

ALTER TABLE corrective_action ADD COLUMN IF NOT EXISTS overdue_notified_at timestamptz;

COMMENT ON COLUMN corrective_action.overdue_notified_at IS
  'When the overdue sweep last announced this action. NULL means unannounced. Not a '
  'statement that the action is overdue — that is derived from status and due_at.';

-- The sweep asks one question per Unit: which of your actions are overdue and unannounced?
-- Partial, because the rows it excludes are almost all of them and stay excluded.
CREATE INDEX IF NOT EXISTS corrective_action_overdue_unannounced_idx
  ON corrective_action (unit_id, due_at)
  WHERE overdue_notified_at IS NULL
    AND due_at IS NOT NULL
    AND status IN ('OPEN', 'REOPENED');
