-- =============================================================================
-- 0043 — A Coordinator makes Zone Leader links (DECISIONS.md R-47)
--
-- The product owner gave the Coordinator CA9's "Copy Zone Leader link" for their own
-- Unit: one more link to an open corrective action, for when the PDF's is lost. Links
-- only — the reports stay the Super Admin's (R-39). `PermissionGuard` is the control —
-- `corrective_action:link` names the role with `own_unit` scope — and this is the
-- defence-in-depth behind it.
--
--   * `report_access_token` admitted the Super Admin alone. It now also admits a
--     Coordinator to read and add corrective-action links of their own Unit's actions.
--     Report-level links stay out of reach, and so does revoking: no UPDATE.
--   * Which report a new link is attached to is the newest listed one that printed a link
--     to the action, and a Coordinator reads no report. One narrow definer function says
--     whether a report is still listed, scoped inside like 0041's `app_reviewer`.
--   * A link with no Zone Leader account acts as the Super Admin who issued it (R-22). A
--     Coordinator answers no finding, so a link they made acts as the Super Admin who
--     generated its report instead. Resolving a link runs before there is an actor, and
--     the report is not readable then, so a second definer function names that account,
--     only inside the auth phase.
-- =============================================================================

CREATE POLICY report_access_token_coordinator_select ON report_access_token FOR SELECT
  USING (
    app_actor_role() = 'COORDINATOR'
    AND purpose = 'CORRECTIVE_ACTION'
    AND unit_id = ANY (app_actor_unit_ids())
  );

CREATE POLICY report_access_token_coordinator_insert ON report_access_token FOR INSERT
  WITH CHECK (
    app_actor_role() = 'COORDINATOR'
    AND purpose = 'CORRECTIVE_ACTION'
    AND unit_id = ANY (app_actor_unit_ids())
    AND EXISTS (
      SELECT 1 FROM corrective_action ca
      WHERE ca.id = report_access_token.corrective_action_id
        AND ca.unit_id = report_access_token.unit_id)
  );

-- True when the report exists, is not removed, and belongs to a Unit the caller holds.
CREATE OR REPLACE FUNCTION app_report_snapshot_listed(p_snapshot_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM report_snapshot s
    WHERE s.id = p_snapshot_id
      AND s.status <> 'REMOVED'
      AND (app_is_super_admin() OR s.unit_id = ANY (app_actor_unit_ids()))
  );
$$;
REVOKE ALL ON FUNCTION app_report_snapshot_listed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_report_snapshot_listed(uuid) TO audit5s_app;

-- The account that generated a link's report, read while resolving that link.
CREATE OR REPLACE FUNCTION app_link_report_generator(p_token_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.generated_by_user_id
  FROM report_access_token t
  JOIN report_snapshot s ON s.id = t.snapshot_id
  WHERE t.id = p_token_id AND app_in_auth_phase();
$$;
REVOKE ALL ON FUNCTION app_link_report_generator(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_link_report_generator(uuid) TO audit5s_app;
