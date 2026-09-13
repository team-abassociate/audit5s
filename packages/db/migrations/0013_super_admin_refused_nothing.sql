-- =============================================================================
-- 0013 — A Super Admin is refused nothing (DECISIONS.md R-18)
--
-- The permission matrix now grants SUPER_ADMIN every permission any role holds, under the
-- `organization` resolver. Two policies still admitted only field roles, so the grant
-- alone would have met a row-level refusal. Each keeps every clause it had and gains the
-- Super Admin beside them; neither is widened for any other role.
-- =============================================================================

-- An audit is inserted by its own auditor, inside one of the auditor's Units. A Super
-- Admin holds no Unit membership (`app_actor_unit_ids()` is empty), so the Unit half
-- refused every audit he started.
DROP POLICY audit_insert ON audit;
CREATE POLICY audit_insert ON audit FOR INSERT
  WITH CHECK (
    auditor_user_id = app_actor_id()
    AND (app_is_super_admin() OR unit_id = ANY (app_actor_unit_ids()))
  );

-- Who may answer a corrective action (0009): a Zone Leader it is assigned to or any Zone
-- Leader of its Unit (R-3b), and now a Super Admin, for any action. Guards both the
-- submission insert and the CORRECTIVE_AFTER evidence policies.
CREATE OR REPLACE FUNCTION app_may_answer_corrective_action(p_action_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM corrective_action ca
    WHERE ca.id = p_action_id
      AND (
        app_is_super_admin()
        OR (app_actor_role() = 'ZONE_LEADER'
            AND (ca.assigned_zone_leader_user_id = app_actor_id()
                 OR ca.unit_id = ANY (app_actor_unit_ids())))
      )
  );
$$;
