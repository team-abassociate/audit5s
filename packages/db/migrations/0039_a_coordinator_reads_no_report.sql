-- =============================================================================
-- 0039 — A Coordinator reads no report (DECISIONS.md R-39)
--
-- The product owner took the PDF reports away from the Coordinator. `PermissionGuard` is
-- the control — `report:read_snapshot` and `report:download` no longer name the role — and
-- this is the defence-in-depth behind it: `report_snapshot_select` admitted anyone holding
-- a membership of the report's Unit, which a Coordinator does. It now admits a Unit
-- member only when they are not a Coordinator. A Zone Leader still reads their Unit's
-- reports, and the Super Admin reads every one.
--
-- Nothing else changes. Writes were already the Super Admin's alone, and
-- `report_access_token` never admitted a Coordinator.
-- =============================================================================

DROP POLICY report_snapshot_select ON report_snapshot;

CREATE POLICY report_snapshot_select ON report_snapshot FOR SELECT
  USING (
    app_is_super_admin()
    OR (unit_id = ANY (app_actor_unit_ids()) AND app_actor_role() <> 'COORDINATOR')
  );
