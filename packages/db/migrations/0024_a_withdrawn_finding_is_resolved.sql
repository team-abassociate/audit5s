-- =============================================================================
-- 0024 — A withdrawn finding is resolved, and was never fixed (DECISIONS.md R-31)
--
-- R-30 let an auditor correct a mark on an audit they had finished. R-31 is the rest of
-- that sentence: a mark does not sit alone. A photograph filed under a 0 is a
-- nonconformity, a nonconformity is a corrective action, and somebody is being chased for
-- it. Correcting the 0 to a 2 and leaving the action open asks a Zone Leader to go and fix
-- something that, on the record, is no longer wrong.
--
-- So a correction cascades: the photograph is reclassified (E-2, which already did exactly
-- this before completion), a finding that has appeared gets an action, and a finding that
-- has gone gets its action **withdrawn**.
--
-- Withdrawn is not verified, and the distinction is the whole reason for a sixth status.
-- VERIFIED means somebody went and fixed it, or said why they could not and was believed.
-- WITHDRAWN means there was nothing to fix. Folding the second into the first would make
-- the closure rate a measure of how often auditors mistype, which is not what anyone reads
-- it for.
--
-- `corrective_action_resolved_iff_verified` is the constraint that has to move, and it
-- moves the smallest distance that stays true: `resolved_at` has always meant "settled, no
-- longer outstanding", and a withdrawn finding is settled on the day it was withdrawn.
-- Analytics keeps the two apart separately — `closed_nc` and the average closure time
-- count VERIFIED alone, because a finding that evaporated took nobody any hours to close.
-- =============================================================================

ALTER TABLE corrective_action
  DROP CONSTRAINT corrective_action_resolved_iff_verified;

ALTER TABLE corrective_action
  ADD CONSTRAINT corrective_action_resolved_iff_settled CHECK (
    (status IN ('VERIFIED', 'WITHDRAWN')) = (resolved_at IS NOT NULL)
  );

COMMENT ON COLUMN corrective_action.resolved_at IS
  'When the action stopped being outstanding: VERIFIED (someone answered it) or WITHDRAWN '
  '(R-31 — the mark it rested on was corrected, so there was nothing to answer).';

-- The overdue index already narrows to OPEN and REOPENED, so a withdrawn action leaves it
-- on the next write with no change here. `corrective_action_unit_status_idx` and its
-- siblings are on `status` itself and need none either.

-- =============================================================================
-- The cascade runs as the system, and the insert policy has to admit it
-- =============================================================================
--
-- Withdrawing a finding and raising one are consequences, not acts: the state machine
-- gives those edges no human actor, and the service takes them through `asSystem` exactly
-- as the audit roll-up already does. The system actor is a Super Admin.
--
-- `corrective_action_update` already admits one. `corrective_action_insert` (0009) admits
-- only the audit's own auditor — which was true of every caller it had, because the one
-- caller was materialisation on the completing transaction. R-31 adds a second: a Super
-- Admin correcting somebody else's completed audit, whose correction turns a 2 into a 0
-- and raises a finding that did not exist.
--
-- Widened rather than given a Consultant clause on purpose. No role gains the ability to
-- write a corrective action directly; what gains it is the system, on a path that has
-- already been through the guard chain, A-2's carve-out and an audit-log entry. R-18 says
-- a Super Admin is refused nothing, and this policy was quietly refusing one.
DROP POLICY corrective_action_insert ON corrective_action;

CREATE POLICY corrective_action_insert ON corrective_action FOR INSERT
  WITH CHECK (
    app_is_super_admin()
    OR EXISTS (SELECT 1 FROM audit a
               WHERE a.id = corrective_action.audit_id AND a.auditor_user_id = app_actor_id())
  );
