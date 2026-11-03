-- =============================================================================
-- 0063 — A Zone's nonconformities are closed by its own leader (R-78)
--
-- Owner, 2026-11-02: the Coordinator names each Zone's leader (R-74), so an NC of that Zone
-- is closed by that leader — not by any Zone Leader of the Unit (R-3b, R-39(b) withdrawn).
-- The Coordinator and the Super Admin still close any of their scope. A Zone with no leader
-- account (typed names only, R-64) is closed by any Zone Leader or Consultant of the Unit,
-- as well as the Coordinator and the Super Admin.
--
-- `PermissionGuard` + `assigned_actions` is the control; this is the defence in depth.
-- `app_may_answer_corrective_action` guards the submission insert and both CORRECTIVE_AFTER
-- evidence policies (0009), so redefining it narrows all three. The action's UPDATE policy
-- is rewritten on it too. Withdrawal and revival run as the system, so they are untouched.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_may_answer_corrective_action(p_action_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM corrective_action ca
    JOIN zone z ON z.id = ca.zone_id
    WHERE ca.id = p_action_id
      AND (
        app_is_super_admin()
        OR (app_actor_role() = 'COORDINATOR' AND ca.unit_id = ANY (app_actor_unit_ids()))
        OR (app_actor_role() IN ('ZONE_LEADER', 'CONSULTANT')
            AND ca.unit_id = ANY (app_actor_unit_ids())
            AND (z.zone_leader_id = app_actor_id() OR z.zone_leader_id IS NULL))
      )
  );
$$;

DROP POLICY corrective_action_update ON corrective_action;
CREATE POLICY corrective_action_update ON corrective_action FOR UPDATE
  USING (
    app_is_super_admin()
    OR (app_actor_role() = 'COORDINATOR' AND unit_id = ANY (app_actor_unit_ids()))
    OR (app_actor_role() IN ('ZONE_LEADER', 'CONSULTANT') AND app_may_answer_corrective_action(id))
  );
