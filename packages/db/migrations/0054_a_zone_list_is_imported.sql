-- =============================================================================
-- 0054 — A Unit's Zone list is imported; until it is, a Consultant adds Zones
--        (DECISIONS.md R-59)
--
-- Owner, 2026-10-25. A Super Admin or a Coordinator imports a Unit's Zone list from an
-- Excel or PDF file (`POST /units/{id}/zones/import`). Each import replaces the list: the
-- Zones it names are added or updated, the Zones it leaves out are archived, and
-- `zone_list_imported_at` records that the Unit now has one.
--
-- R-52 let only a Super Admin or a Coordinator add a Zone during an audit. That stands for a
-- Unit with an imported list. For a Unit without one, the Consultant auditing it may add a
-- Zone the same way ("+ New Zone" on Select Zone) — otherwise a Unit nobody has set up
-- could not be audited at all. A Zone Leader still cannot.
-- =============================================================================

ALTER TABLE unit ADD COLUMN IF NOT EXISTS zone_list_imported_at timestamptz;

COMMENT ON COLUMN unit.zone_list_imported_at IS
  'When a Super Admin or Coordinator last imported this Unit''s Zone list (0054). NULL: never, '
  'and a Consultant auditing the Unit may add Zones itself.';

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

  IF app_is_super_admin()
     OR app_actor_role() = 'COORDINATOR'
     OR (app_actor_role() = 'CONSULTANT'
         AND EXISTS (SELECT 1 FROM unit u WHERE u.id = v_unit_id AND u.zone_list_imported_at IS NULL)) THEN
    INSERT INTO zone (unit_id, code, name, description, sort_order)
    VALUES (v_unit_id, p_code, p_name, NULLIF(btrim(p_description), ''), p_sort_order)
    ON CONFLICT (unit_id, code) DO NOTHING
    RETURNING id INTO v_zone_id;

    IF v_zone_id IS NOT NULL THEN
      RETURN QUERY SELECT v_zone_id, true;
      RETURN;
    END IF;
  END IF;

  SELECT z.id INTO v_zone_id FROM zone z WHERE z.unit_id = v_unit_id AND z.code = p_code;
  RETURN QUERY SELECT v_zone_id, false;
END;
$$;
