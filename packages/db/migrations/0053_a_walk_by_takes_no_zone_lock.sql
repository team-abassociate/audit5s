-- =============================================================================
-- 0053 — A walk-by neither holds a Zone nor is held off one (R-29, narrowed)
--
-- Owner, 2026-10-24: one Zone, one open audit stays the rule for the scored 5S audits
-- (EXTERNAL_5S, CROSS_5S). A walk-by is exempt both ways. An auditor is often accompanied
-- by a senior person who runs a walk-by of the same Zones at the same time, and a walk-by
-- has no score to duplicate.
--
-- So a walk-by's audit Zones never set `audit_open` (no claim, so nothing is refused for
-- them and the picker never shows them as taken), and the claim check answers "free" for a
-- walk-by asking. Nothing else changes: a scored audit is still refused a Zone another
-- scored audit holds.
-- =============================================================================

-- The claim check: a walk-by is never refused, and a walk-by never holds.
CREATE OR REPLACE FUNCTION app_zone_claimed_by_other_audit(
  p_zone_id  uuid,
  p_audit_id uuid
) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT a.id
  FROM audit_zone az
  JOIN audit a ON a.id = az.audit_id
  WHERE az.zone_id = p_zone_id
    AND az.audit_id <> p_audit_id
    AND az.status <> 'WITHDRAWN'
    AND a.audit_type <> 'WALK_BY'
    AND a.unit_id = (SELECT unit_id FROM audit WHERE id = p_audit_id)
    AND a.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED')
    AND (SELECT audit_type FROM audit WHERE id = p_audit_id) <> 'WALK_BY'
  ORDER BY a.started_at NULLS LAST, a.id
  LIMIT 1;
$fn$;

-- The flag on insert: a walk-by's Zone is never a claim.
CREATE OR REPLACE FUNCTION audit_zone_set_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  SELECT (a.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED') AND a.audit_type <> 'WALK_BY')
  INTO NEW.audit_open
  FROM audit a WHERE a.id = NEW.audit_id;

  RETURN NEW;
END;
$fn$;

-- The flag on an audit's status change (0031's body): a restarted walk-by re-claims nothing.
CREATE OR REPLACE FUNCTION audit_release_zones() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_open boolean := NEW.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED')
                    AND NEW.audit_type <> 'WALK_BY';
BEGIN
  IF v_open IS DISTINCT FROM (OLD.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED')) THEN
    UPDATE audit_zone
    SET audit_open = v_open AND status <> 'WITHDRAWN'
    WHERE audit_id = NEW.id
      AND audit_open IS DISTINCT FROM (v_open AND status <> 'WITHDRAWN');
  END IF;

  RETURN NEW;
END;
$fn$;

-- What the picker reads (0021's body): a walk-by is shown no Zone as taken.
CREATE OR REPLACE FUNCTION app_zone_locks_for_audit(p_audit_id uuid)
RETURNS TABLE (
  lock_zone_id      uuid,
  lock_zone_code    text,
  lock_zone_name    text,
  lock_audit_id     uuid,
  lock_auditor_name text,
  lock_audit_status audit_status
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_unit_id uuid;
BEGIN
  SELECT a.unit_id INTO v_unit_id
  FROM audit a
  WHERE a.id = p_audit_id
    AND a.audit_type <> 'WALK_BY'
    AND (
      app_is_super_admin()
      OR a.auditor_user_id = app_actor_id()
      OR a.unit_id = ANY (app_actor_unit_ids())
    );

  IF v_unit_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT DISTINCT ON (z.id)
      z.id, z.code, z.name, a.id, u.full_name, a.status
    FROM audit_zone az
    JOIN audit a ON a.id = az.audit_id
    JOIN zone z  ON z.id = az.zone_id
    JOIN "user" u ON u.id = a.auditor_user_id
    WHERE az.audit_open
      AND az.audit_id <> p_audit_id
      AND a.unit_id = v_unit_id
    ORDER BY z.id, a.started_at NULLS LAST, a.id;
END;
$fn$;

-- Walk-by Zones already holding a claim let it go. `audit_open` is 0021's carve-out column,
-- so this is allowed on a completed audit's rows too (it only touches open ones here).
UPDATE audit_zone az
SET audit_open = false
FROM audit a
WHERE a.id = az.audit_id
  AND a.audit_type = 'WALK_BY'
  AND az.audit_open;
