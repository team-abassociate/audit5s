-- =============================================================================
-- 0032 — A Consultant keeps their Unit while any audit of theirs there is still open
--
-- Field report, 2026-09-23: a Consultant ran three audits of one Unit in a day. All three
-- were linked to the same open assignment, because `resolveAssignment` links the open one
-- to every external audit started while it is open. Finishing the second audit closed
-- that assignment, and with it (0019) the Consultant's only grant on the Unit — while the
-- first and third audits were still open on the same phone. Their next sync items were
-- refused as "No such audit" (`app_ensure_zone_for_audit` answers only inside the actor's
-- Units) and landed in the quarantine as "Access was revoked mid-audit". The Super Admin
-- read that as the Consultant's access having been revoked. It had not; it had lapsed
-- under them mid-audit.
--
-- R-28 makes the assignment a *temporary* grant, and that stays. What this changes is when
-- the grant ends: not at the instant the assignment closes, but once the Consultant has no
-- open audit left in the Unit. An audit in progress is work the Consultant was sent to do,
-- and the Unit it is being done in cannot disappear from under it. A restarted audit
-- (R-33) is open again, so it gets its Unit back for as long as the restart lasts.
--
-- What it opens: the Units of audits this Consultant is conducting right now, and only
-- while those audits are ASSIGNED / READY / IN_PROGRESS / PAUSED. A Consultant whose audits
-- in a Unit are all finished or cancelled, and who holds no open assignment there, still
-- has no access to it — exactly as before. Coordinator and Zone Leader tenancy is
-- untouched: the clause is CONSULTANT-only, like 0019's.
--
-- `audit` does not FORCE row-level security, so this definer function reads it as its
-- owner and the `audit_select` policy that calls this function is not re-entered.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_actor_unit_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT scoped.unit_id), ARRAY[]::uuid[])
  FROM (
    SELECT m.unit_id
    FROM unit_membership m
    WHERE m.user_id = app_actor_id()
      AND m.status = 'ACTIVE'
      AND now() >= m.valid_from
      AND (m.valid_to IS NULL OR now() < m.valid_to)

    UNION

    SELECT aa.unit_id
    FROM audit_assignment aa
    WHERE app_actor_role() = 'CONSULTANT'
      AND aa.auditor_user_id = app_actor_id()
      AND aa.status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS')

    UNION

    SELECT a.unit_id
    FROM audit a
    WHERE app_actor_role() = 'CONSULTANT'
      AND a.auditor_user_id = app_actor_id()
      AND a.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED')
  ) AS scoped;
$$;
