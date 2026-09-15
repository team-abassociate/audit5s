-- =============================================================================
-- 0014 — The auditor names the Zone (DECISIONS.md R-19)
--
-- The product owner settled how an audit begins: a selfie, then a Zone form — Zone 1…100
-- from a dropdown, an optional description, the Zone leader's name typed in, and the
-- department. A Zone no longer has to exist in master data before it can be audited.
--
-- `zone_insert` stays exactly as 0005 wrote it: a Consultant or Zone Leader still cannot
-- create a Zone through `POST /units/{id}/zones`. The only new path is this function, and
-- it is narrower than any policy could be. It adds a Zone only to the Unit of an audit the
-- caller is conducting, only while that audit is still open, and only by code. For
-- anything else it returns no row, which the service reports as a missing audit.
--
-- `ON CONFLICT DO NOTHING` lets two devices naming Zone 7 of one Unit at the same moment
-- agree on one row, rather than one of them failing on `zone_unit_code_key`.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_ensure_zone_for_audit(
  p_audit_id    uuid,
  p_code        text,
  p_name        text,
  p_description text,
  p_sort_order  integer
) RETURNS TABLE (ensured_zone_id uuid, was_created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_unit_id uuid;
  v_zone_id uuid;
BEGIN
  -- The caller's own audit, inside one of the caller's Units — the same two conditions
  -- `audit_insert` (0013) put on the audit itself — and still being conducted.
  SELECT a.unit_id INTO v_unit_id
  FROM audit a
  WHERE a.id = p_audit_id
    AND a.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED')
    AND (
      app_is_super_admin()
      OR (a.auditor_user_id = app_actor_id() AND a.unit_id = ANY (app_actor_unit_ids()))
    );

  IF v_unit_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO zone (unit_id, code, name, description, sort_order)
  VALUES (v_unit_id, p_code, p_name, NULLIF(btrim(p_description), ''), p_sort_order)
  ON CONFLICT (unit_id, code) DO NOTHING
  RETURNING id INTO v_zone_id;

  IF v_zone_id IS NOT NULL THEN
    RETURN QUERY SELECT v_zone_id, true;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT z.id, false FROM zone z WHERE z.unit_id = v_unit_id AND z.code = p_code;
END;
$$;

REVOKE ALL ON FUNCTION app_ensure_zone_for_audit(uuid, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_ensure_zone_for_audit(uuid, text, text, text, integer) TO audit5s_app;
