-- =============================================================================
-- 0041 — A Coordinator reviews corrective actions (DECISIONS.md R-43)
--
-- The product owner gave the Coordinator the Super Admin's review of their own Unit's
-- corrective actions: approve or disapprove a Zone Leader's closure, and accept or reopen a
-- "not possible". `PermissionGuard` is the control — `corrective_action:verify` and
-- `:reopen` now name the role with `own_unit` scope — and this is the defence-in-depth
-- behind it.
--
--   * `corrective_action_update` already admitted a Coordinator of the action's Unit.
--   * `corrective_action_submission_update` admitted the Super Admin alone. A review is
--     recorded on the attempt, so it now admits a Coordinator whose Unit holds the action.
--     CA-1's two triggers still stand: only the four review columns move, and only once.
--
-- And one narrow definer function, so a report or a phone can say *who* reviewed an
-- attempt and in which role, without a Coordinator reading the Super Admin's user row.
-- =============================================================================

DROP POLICY corrective_action_submission_update ON corrective_action_submission;

CREATE POLICY corrective_action_submission_update ON corrective_action_submission FOR UPDATE
  USING (
    app_is_super_admin()
    OR (app_actor_role() = 'COORDINATOR' AND EXISTS (
      SELECT 1 FROM corrective_action ca
      WHERE ca.id = corrective_action_submission.corrective_action_id
        AND ca.unit_id = ANY (app_actor_unit_ids())))
  );

-- `{ "name": …, "role": … }` of the user who reviewed some attempt the caller may read, or
-- null. Scoped inside the definer function, like 0008's and 0010's name functions, so
-- bypassing RLS for one display string cannot enumerate people.
CREATE OR REPLACE FUNCTION app_reviewer(p_user_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('name', u.full_name, 'role', u.role)
  FROM "user" u
  WHERE u.id = p_user_id
    AND EXISTS (
      SELECT 1
      FROM corrective_action_submission s
      JOIN corrective_action ca ON ca.id = s.corrective_action_id
      WHERE s.reviewed_by_user_id = p_user_id
        AND (app_is_super_admin() OR ca.unit_id = ANY (app_actor_unit_ids()))
    )
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION app_reviewer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_reviewer(uuid) TO audit5s_app;
