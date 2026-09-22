-- =============================================================================
-- 0027 — An auditor can still read the Unit of an audit they have finished
--
-- Field report: a Consultant reassigned to a Unit conducted an audit, finished it, and the
-- phone answered "Scores not available" on a score the server had already computed and the
-- admin portal was already showing. `POST /audits/{id}/complete` returned `404 No such
-- audit` — *after* completing and scoring it.
--
-- The chain:
--
--   1. Completing an audit closes the `audit_assignment` that fulfilled it (§7.1), moving
--      it to `COMPLETED`.
--   2. `app_actor_unit_ids()` (0019) counts a Consultant's assignments only while they are
--      `ASSIGNED` / `ACCEPTED` / `IN_PROGRESS`. So the Unit leaves the actor's set at the
--      instant the audit finishes — correctly: R-28 makes the assignment a *temporary*
--      grant, and a finished auditor should not keep starting audits there.
--   3. `unit_select` admitted a row only through that set.
--   4. Every audit read joins `unit` for `unit_name` — `readAudit`, and the audit list.
--      An `INNER JOIN` against a row RLS hides returns nothing, so the audit itself
--      became unreadable to the person who conducted it.
--
-- Step 2 is right and stays. Step 3 is the defect: `unit` is the only table on that read
-- path with no clause for the auditor. `audit_select`, `audit_zone_select`,
-- `question_response_select`, `audit_zone_section_score_select` and `evidence_select` all
-- read `... OR a.auditor_user_id = app_actor_id()`, precisely so an auditor can read their
-- own work back. `unit` was missing the same clause, and PART 6 has meant it all along:
-- `own_audits` is what a Consultant is granted on `audit:read` and `report:score_summary`,
-- and it says nothing about still holding the Unit.
--
-- What this opens: SELECT on the `unit` rows of audits this actor conducted, for as long
-- as those audits exist. Nothing else. `app_actor_unit_ids()` is untouched, so audit
-- creation (`audit_insert`), Zones, sync and the analytics tables are unchanged — a
-- Consultant whose assignment has closed still cannot start another audit in that Unit.
-- `unit_update` is untouched. The application layer is unchanged too: `unit:read` still
-- resolves to `assigned_units` for a Consultant (PART 6), so `GET /units` still lists only
-- Units they currently hold. This admits the join, not the Unit master.
-- =============================================================================

-- A definer function rather than an inline `EXISTS` on `audit`, for the reason 0019 gives:
-- it keeps the policy from evaluating another table's policies, and being `STABLE` it is
-- evaluated once per query rather than once per Unit row.
CREATE OR REPLACE FUNCTION app_audited_unit_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT a.unit_id), ARRAY[]::uuid[])
  FROM audit a
  WHERE a.auditor_user_id = app_actor_id();
$$;

REVOKE ALL ON FUNCTION app_audited_unit_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_audited_unit_ids() TO audit5s_app;

DROP POLICY unit_select ON unit;
CREATE POLICY unit_select ON unit FOR SELECT
  USING (
    app_is_super_admin()
    OR id = ANY (app_actor_unit_ids())
    OR id = ANY (app_audited_unit_ids())
  );
