-- =============================================================================
-- 0049 — A Coordinator answers their own Unit's corrective actions
--
-- Owner, 2026-10-13: a Coordinator records a fix ("Done", with the after-photo) or a
-- "not possible" in their own Unit, exactly as a Zone Leader does. `PermissionGuard` is the
-- control — `corrective_action:submit` now names the role with `own_unit` scope — and this
-- is the defence-in-depth behind it.
--
-- `app_may_answer_corrective_action` guards the submission insert and both CORRECTIVE_AFTER
-- evidence policies (0009), so widening it once admits all three. The action's own UPDATE
-- policy already admitted a Coordinator of its Unit (0009), and the attempt's UPDATE policy
-- (0041) lets the Coordinator record their own closure as approved on it.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_may_answer_corrective_action(p_action_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM corrective_action ca
    WHERE ca.id = p_action_id
      AND (
        app_is_super_admin()
        OR (app_actor_role() = 'COORDINATOR' AND ca.unit_id = ANY (app_actor_unit_ids()))
        OR (app_actor_role() = 'ZONE_LEADER'
            AND (ca.assigned_zone_leader_user_id = app_actor_id()
                 OR ca.unit_id = ANY (app_actor_unit_ids())))
      )
  );
$$;
