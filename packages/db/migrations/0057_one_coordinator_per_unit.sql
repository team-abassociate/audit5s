-- =============================================================================
-- 0057 — A Unit has one Coordinator (DECISIONS.md R-64)
--
-- Owner, 2026-10-27: "there should be only one coordinator in a particular unit". M-1
-- already gives a Coordinator one Unit; this gives a Unit one Coordinator, as an index the
-- API maps to a refusal, so no path — Create user, Assign to a Unit — can make a second.
--
-- Before the index, a Unit holding two (on 2026-10-27 only the dummy Unit "Xyz", which the
-- owner said to resolve) keeps the Coordinator who signed in last and revokes the other's
-- membership, as "Revoke access" would: status REVOKED, valid_to set. Nothing is deleted;
-- the revoked person keeps their account and history, and a Super Admin may assign them
-- another Unit.
-- =============================================================================

UPDATE unit_membership m
SET status = 'REVOKED', valid_to = now()
WHERE m.status = 'ACTIVE'
  AND m.role = 'COORDINATOR'
  AND m.id <> (
    SELECT keep.id
    FROM unit_membership keep
    JOIN "user" u ON u.id = keep.user_id
    WHERE keep.unit_id = m.unit_id
      AND keep.status = 'ACTIVE'
      AND keep.role = 'COORDINATOR'
    ORDER BY u.last_login_at DESC NULLS LAST, keep.created_at
    LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS unit_membership_one_coordinator
  ON unit_membership (unit_id)
  WHERE status = 'ACTIVE' AND role = 'COORDINATOR';
