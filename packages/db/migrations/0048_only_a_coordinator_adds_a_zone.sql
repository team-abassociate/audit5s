-- =============================================================================
-- 0048 — Only a Coordinator or a Super Admin adds a Zone; a renamed Zone is renamed
--        everywhere (DECISIONS.md R-52)
--
-- Owner, 2026-10-12. Two changes to how a Unit's Zones are kept:
--
--   * During an audit, a Consultant or a Zone Leader picks one of the Unit's Zones and
--     cannot add one. `app_ensure_zone_for_audit` (0014) added any Zone an auditor named;
--     it now adds one only for a Super Admin or a Coordinator. For anyone else it returns
--     the Zone when the Unit has it, and a NULL id when it does not, which the API turns
--     into `403 ZONE_CREATE_FORBIDDEN`. An older phone still sending a new number is
--     refused here, not trusted to behave.
--
--   * Renaming a Zone — `Zone 1` to `Zone 1A — Press line` — relabels every audit of it,
--     finished ones included, so the old reports and their corrective actions read the new
--     name. This overrides D6's snapshot for the code and name only: the description and
--     the leader's name an auditor typed stay as they were typed. The trigger is a definer
--     because `audit_zone_update` admits only the auditor, and the rename is the Zone
--     owner's act, already authorised by `zone_update` and logged as `zone.updated` with
--     its before and after. The append-only guard (0021) gains one carve-out for it: the
--     two snapshot columns may change on a finished audit only to the Zone's live values.
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

  IF app_is_super_admin() OR app_actor_role() = 'COORDINATOR' THEN
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

-- 0021's guard, unchanged but for the R-52 carve-out.
CREATE OR REPLACE FUNCTION enforce_completed_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  -- Statuses at or past COMPLETED. The corrective-action statuses are included because
  -- they are all downstream of completion: the audited facts are settled by then.
  frozen_statuses audit_status[] := ARRAY['COMPLETED','CORRECTIVE_ACTION_OPEN',
                                          'PARTIALLY_CLOSED','CLOSED']::audit_status[];
  -- The audit's own lifecycle continues past COMPLETED — corrective actions move it
  -- through three more statuses — so those columns stay writable on `audit` itself.
  -- They are the status and its timestamps, and nothing that was audited.
  lifecycle_columns text[] := ARRAY['status','closed_at','updated_at','version'];
  -- R-29: the Zone lock, released on the same edge that freezes the row.
  lock_columns text[] := ARRAY['audit_open'];
  owning_audit   uuid;
  audit_state    audit_status;
  changed_column text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A-1/D8, with no carve-out at all: not for a Super Admin, not under an override.
    RAISE EXCEPTION
      'Table % is never deleted from: an audit is cancelled, not removed (A-1, D8)',
      TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_TABLE_NAME = 'audit' THEN
    -- The row being updated *is* the audit, and the move out of COMPLETED is what is
    -- being judged, so read the pre-image rather than the table.
    owning_audit := OLD.id;
    audit_state  := OLD.status;
  ELSE
    owning_audit := OLD.audit_id;
    SELECT a.status INTO audit_state FROM audit a WHERE a.id = owning_audit;
  END IF;

  IF NOT (audit_state = ANY (frozen_statuses)) THEN
    RETURN NEW;
  END IF;

  IF app_post_completion_override() THEN
    RETURN NEW;
  END IF;

  FOR changed_column IN
    SELECT key
    FROM jsonb_each(to_jsonb(OLD)) AS o(key, value)
    WHERE o.value IS DISTINCT FROM (to_jsonb(NEW) -> o.key)
  LOOP
    IF TG_TABLE_NAME = 'audit' AND changed_column = ANY (lifecycle_columns) THEN
      CONTINUE;
    END IF;

    IF TG_TABLE_NAME = 'audit_zone' AND changed_column = ANY (lock_columns) THEN
      CONTINUE;
    END IF;

    -- R-52: a renamed Zone relabels its finished audits — to the Zone's own code and name
    -- and nothing else, so this cannot be used to write any other text into history.
    -- Nested, not ANDed: plpgsql does not promise to skip `NEW.zone_id` on a table without it.
    IF TG_TABLE_NAME = 'audit_zone'
       AND changed_column IN ('zone_code_snapshot', 'zone_name_snapshot') THEN
      IF EXISTS (SELECT 1 FROM zone z
                 WHERE z.id = NEW.zone_id
                   AND z.code = NEW.zone_code_snapshot
                   AND z.name = NEW.zone_name_snapshot) THEN
        CONTINUE;
      END IF;
    END IF;

    RAISE EXCEPTION
      'Audit % is %: %.% may not be updated after completion. The post-completion '
      'override endpoint is the only path, and it writes an audit-log entry with '
      'before and after (A-2)',
      owning_audit, audit_state, TG_TABLE_NAME, changed_column
      USING ERRCODE = 'restrict_violation';
  END LOOP;

  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_relabel_audit_zones() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE audit_zone
  SET zone_code_snapshot = NEW.code, zone_name_snapshot = NEW.name
  WHERE zone_id = NEW.id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app_relabel_audit_zones() FROM PUBLIC;

CREATE TRIGGER zone_relabels_its_audits
  AFTER UPDATE OF code, name ON zone
  FOR EACH ROW
  WHEN (OLD.code IS DISTINCT FROM NEW.code OR OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION app_relabel_audit_zones();
