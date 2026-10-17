-- =============================================================================
-- 0052 — Kaizen access is granted person by person, the way 5S access is
--
-- Owner, 2026-10-17 (R-57): access to 5S no longer brings Kaizen with it. A Super Admin
-- grants or revokes Kaizen for anyone; a Coordinator who holds it, for their Unit's Zone
-- Leaders. A Super Admin always has it. Nobody holds it until granted.
--
-- `PermissionGuard` and `scopeFor` are the control (`grantForActor`); this is the
-- defence-in-depth behind them. A RESTRICTIVE policy is ANDed with every permissive one
-- 0044 wrote, so no Kaizen policy had to be rewritten. The actor reads their own `user` row
-- under `user_select`, so the function needs no SECURITY DEFINER.
-- =============================================================================

ALTER TABLE "user" ADD COLUMN kaizen_access boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION app_has_kaizen_access() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_super_admin()
      OR EXISTS (SELECT 1 FROM "user" u WHERE u.id = app_actor_id() AND u.kaizen_access);
$$;

CREATE POLICY kaizen_access ON kaizen AS RESTRICTIVE FOR ALL
  USING (app_has_kaizen_access()) WITH CHECK (app_has_kaizen_access());
CREATE POLICY kaizen_review_access ON kaizen_review AS RESTRICTIVE FOR ALL
  USING (app_has_kaizen_access()) WITH CHECK (app_has_kaizen_access());
CREATE POLICY kaizen_photo_access ON kaizen_photo AS RESTRICTIVE FOR ALL
  USING (app_has_kaizen_access()) WITH CHECK (app_has_kaizen_access());

COMMENT ON COLUMN "user".kaizen_access IS
  'Granted by a Super Admin, or by a Coordinator holding it for their Zone Leaders (R-57).';
