-- =============================================================================
-- 0031 — A withdrawn Zone leaves its audit and releases its lock
--
-- 0030 added WITHDRAWN. This is what it means, enforced where it cannot be forgotten:
--
--   1. **The Zone is free again.** R-29 (0021) holds a Zone while any open audit covers it.
--      A withdrawn Zone covers nothing, so its `audit_open` flag drops the moment the status
--      lands, and stays down if the audit is later restarted (R-33 reopens an audit, and
--      0021's release trigger would otherwise re-claim every Zone it ever had).
--   2. **It may be audited again in the same audit.** `audit_zone_audit_zone_key` made a
--      Zone appear once per audit; it now counts only Zones not withdrawn, so an auditor
--      who aborted Zone 3 by mistake can start Zone 3 afresh — as a new audit Zone, with
--      the withdrawn one still on record beside it.
--   3. **Why, and when.** The auditor's reason (optional) and the moment are kept on the
--      row, because a withdrawn Zone that says nothing is a hole in the record.
--
-- Nothing is deleted. The withdrawn Zone's answers and photographs stay exactly where they
-- were (A-1); every reader that means "what was audited" already filters on
-- `completed_at IS NOT NULL`, which a withdrawn Zone never has.
-- =============================================================================

ALTER TABLE audit_zone
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdraw_reason text;

COMMENT ON COLUMN audit_zone.withdrawn_at IS
  'When the auditor withdrew this unfinished Zone from its audit (status WITHDRAWN).';
COMMENT ON COLUMN audit_zone.withdraw_reason IS
  'The reason the auditor gave for withdrawing the Zone, if any.';

-- 2. One live audit Zone per Zone per audit, not one ever.
DROP INDEX IF EXISTS audit_zone_audit_zone_key;
CREATE UNIQUE INDEX audit_zone_audit_zone_key ON audit_zone (audit_id, zone_id)
  WHERE status <> 'WITHDRAWN';

-- Postgres checks unique indexes in creation order, and the error names the first one hit.
-- Recreating the key above made it younger than R-29's lock index, so the same Zone twice
-- in one audit began to report as "held by another audit". The lock index is rebuilt
-- after it, restoring the order the API's error mapping reads — and only when 0021 was
-- able to create it, for the same reason 0021 gives.
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'audit_zone_claimed_by_open_audit') THEN
    DROP INDEX audit_zone_claimed_by_open_audit;
    CREATE UNIQUE INDEX audit_zone_claimed_by_open_audit ON audit_zone (zone_id) WHERE audit_open;
  END IF;
END;
$mig$;

-- 1a. The release, on the edge itself. BEFORE UPDATE so it rides the same row write; the
-- name sorts after `audit_zone_append_only_after_completion`, which a withdrawal never
-- meets anyway — only an open audit's Zone can be withdrawn.
CREATE OR REPLACE FUNCTION audit_zone_release_on_withdraw() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status = 'WITHDRAWN' THEN
    NEW.audit_open := false;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS audit_zone_withdrawal_releases ON audit_zone;
CREATE TRIGGER audit_zone_withdrawal_releases
  BEFORE UPDATE ON audit_zone
  FOR EACH ROW EXECUTE FUNCTION audit_zone_release_on_withdraw();

-- 1b. 0021's audit-level release, taught that a withdrawn Zone never re-claims.
CREATE OR REPLACE FUNCTION audit_release_zones() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_open boolean := NEW.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED');
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

-- 1c. The claim check reads the Zone's own status too, not only its audit's.
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
    AND a.unit_id = (SELECT unit_id FROM audit WHERE id = p_audit_id)
    AND a.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED')
  ORDER BY a.started_at NULLS LAST, a.id
  LIMIT 1;
$fn$;

-- A Zone being archived is not "in an audit" because of a Zone somebody walked away from.
CREATE OR REPLACE FUNCTION zone_has_in_progress_audit(target_zone_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM audit_zone az
    JOIN audit a ON a.id = az.audit_id
    WHERE az.zone_id = target_zone_id
      AND az.status NOT IN ('COMPLETED', 'WITHDRAWN')
      AND a.status IN ('ASSIGNED','READY','IN_PROGRESS','PAUSED')
  );
$$;
