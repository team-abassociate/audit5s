-- =============================================================================
-- 0066 — A Super Admin or Coordinator reminds a Zone Leader of open NCs (DECISIONS.md R-87)
--
-- Who last reminded, and when, so the next person sees it was done and a Zone Leader is
-- not reminded twice in a day. Named rather than pointing at a user: everyone who reads the
-- action reads this line, and most of them may not read the sender's `user` row. The
-- same choice `corrective_action_submission.submitted_by_name` made.
--
-- `corrective_action_update` already admits the Super Admin and the Unit's Coordinator.
-- =============================================================================

ALTER TABLE corrective_action
  ADD COLUMN last_reminded_at timestamptz,
  ADD COLUMN last_reminded_by_name text;

COMMENT ON COLUMN corrective_action.last_reminded_at IS
  'When someone last sent the Zone''s leader a reminder covering this action (R-87). '
  'Not version-bumped: a reminder must not make a reviewer''s open copy stale.';
