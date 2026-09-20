-- =============================================================================
-- 0021 — One Zone, one open audit (DECISIONS.md R-29)
--
-- A Unit may be assigned to two Consultants, and the product owner settled that they may
-- walk it on the same morning. Nothing in the schema stopped both of them from auditing
-- Zone 1. `audit_zone_audit_zone_key` (0006) makes a Zone unique **within one audit**, so
-- two audits of one Unit could each hold Zone 1 and each produce a score for it — two
-- independent readings of one Zone on one day, which is not a disagreement a report can
-- render. It is a duplicate, and the second one is waste: the auditor walked a Zone that
-- was already being walked.
--
-- So the Zone is claimed while an audit holding it is open, and released when that audit
-- completes or is cancelled. "Open" is the same four statuses `zone_has_in_progress_audit`
-- (0006) already treats as live.
--
-- Two differences from that function, and they are the reason this is not a call to it:
--
--   * It asks "is anyone auditing this Zone", which is true of the caller's own audit.
--     This asks "is anyone **else**", so the audit re-sending its own Zone — a sync retry,
--     an upsert of a Zone already inserted — is not refused by its own claim.
--   * It ignores a Zone already finished inside a still-open audit. Here that Zone is
--     still claimed: a Consultant who finished Zone 1 an hour ago has audited it today,
--     and a second reading is the duplicate this migration exists to prevent.
--
-- The trigger is the control and the endpoint below is the courtesy. The field app cannot
-- ask before it writes — it is offline by design, and a Zone may be claimed hours after a
-- device last saw the server — so the refusal has to survive arriving in a sync batch
-- three days late, where it becomes a quarantined item a Super Admin can read (§9.5)
-- rather than a silent second score.
-- =============================================================================

-- --------------------------------------------------------------------------- the claim
--
-- SECURITY DEFINER for the same reason 0006 gave `zone_has_in_progress_audit`: RLS on
-- `audit` hides another Consultant's audit from this one, and a lock check that cannot see
-- the lock answers "free" — the one wrong answer it must not give.
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
    AND a.unit_id = (SELECT unit_id FROM audit WHERE id = p_audit_id)
    AND a.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED')
  ORDER BY a.started_at NULLS LAST, a.id
  LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION app_zone_claimed_by_other_audit(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_zone_claimed_by_other_audit(uuid, uuid) TO audit5s_app;

-- ------------------------------------------------- A-2's carve-out for the lock column
--
-- `audit_zone` freezes when its audit reaches COMPLETED (0006), and the release below
-- writes to it on exactly that edge. Without a carve-out the completion refuses itself.
--
-- This is the same shape as R-5's evidence-redaction carve-out: a named column beside the
-- rule it bends, rather than a wider override. `audit_open` is not an audited fact — it is
-- a lock, derived from `audit.status`, written only by the triggers in this migration, and
-- read by nothing a report renders. Freezing it would freeze the Zone too: an audit that
-- completed would hold its Zones for ever, and no later audit could take them.
--
-- The body is 0006's, unchanged but for the one `CONTINUE`. It is replaced **before** the
-- column below is backfilled, because that backfill is itself an UPDATE of `audit_zone`
-- rows belonging to completed audits — under 0006's body it would refuse this migration.
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

-- ------------------------------------------------------------- the derived open flag
--
-- Two devices inserting the same Zone of one Unit in the same instant both pass a check
-- that reads committed rows only, and both insert. A unique index closes that window, but
-- its predicate would have to read `audit.status`, which lives on another table. This
-- column is the workable half, and it is written by trigger alone — nothing outside the
-- database sets it.
ALTER TABLE audit_zone ADD COLUMN IF NOT EXISTS audit_open boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN audit_zone.audit_open IS
  'R-29 denormalisation: whether the owning audit is still open. Written by trigger only.';

UPDATE audit_zone az
SET audit_open = (a.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'))
FROM audit a
WHERE a.id = az.audit_id
  AND az.audit_open <> (a.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'));

-- An `audit_zone` inserted into an audit that is already closed — a late sync item for an
-- audit a Super Admin cancelled meanwhile — must not claim the Zone.
CREATE OR REPLACE FUNCTION audit_zone_set_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  SELECT (a.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'))
  INTO NEW.audit_open
  FROM audit a WHERE a.id = NEW.audit_id;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS audit_zone_open_from_audit ON audit_zone;
CREATE TRIGGER audit_zone_open_from_audit
  BEFORE INSERT ON audit_zone
  FOR EACH ROW EXECUTE FUNCTION audit_zone_set_open();

-- The release itself.
--
-- It writes to `audit_zone` on the very edge that freezes it, so it depends on the carve-out
-- above and on one fact about trigger order: Postgres fires BEFORE ROW triggers in **name**
-- order, and `audit_zone_append_only_after_completion` sorts before `audit_zone_set_updated_at`.
-- The append-only check therefore runs while `updated_at` is still untouched and sees
-- `audit_open` as the only changed column. Renaming either trigger would break that.
CREATE OR REPLACE FUNCTION audit_release_zones() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_open boolean := NEW.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED');
BEGIN
  IF v_open IS DISTINCT FROM (OLD.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED')) THEN
    UPDATE audit_zone SET audit_open = v_open WHERE audit_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS audit_release_zones_on_status ON audit;
CREATE TRIGGER audit_release_zones_on_status
  AFTER UPDATE OF status ON audit
  FOR EACH ROW EXECUTE FUNCTION audit_release_zones();

-- ------------------------------------------------------------------------- the control
--
-- BEFORE INSERT only. An update that moves an `audit_zone` to another Zone is not a thing
-- the API offers — the first write resolves the master Zone and every later one keeps it
-- (D6) — and a trigger that re-checked on every update would refuse the routine upsert of
-- a Zone against its own claim.
--
-- The name sorts last on purpose. Postgres fires BEFORE ROW triggers in name order, and
-- the refusal should be the final word on the insert rather than something the flag-setting
-- trigger runs after. It reads `audit` rather than `NEW.audit_open`, so the order could not
-- make it wrong in any case — the name is there for the reader, not for correctness.
CREATE OR REPLACE FUNCTION audit_zone_refuse_claimed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_other uuid;
BEGIN
  v_other := app_zone_claimed_by_other_audit(NEW.zone_id, NEW.audit_id);

  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'unique_violation',
      CONSTRAINT = 'audit_zone_claimed_by_open_audit',
      MESSAGE = format('Zone %s is already held by open audit %s of this Unit', NEW.zone_id, v_other),
      HINT = 'That audit must finish or be cancelled before another audit takes the Zone';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS audit_zone_zclaim ON audit_zone;
CREATE TRIGGER audit_zone_zclaim
  BEFORE INSERT ON audit_zone
  FOR EACH ROW EXECUTE FUNCTION audit_zone_refuse_claimed();

COMMENT ON TRIGGER audit_zone_zclaim ON audit_zone IS
  'R-29: a Zone held by another open audit of the same Unit cannot be added to this one.';

-- The index that closes the concurrent-insert window. Its violation carries the same name
-- the trigger raises, so the API maps one code to both.
--
-- Existing duplicates, if a Unit already collected them, would fail the build. They are
-- real audits with real answers and nothing here deletes one: the index is created only
-- when the data admits it, and the migration says so out loud when it does not.
DO $mig$
DECLARE
  v_dupes integer;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT az.zone_id
    FROM audit_zone az
    WHERE az.audit_open
    GROUP BY az.zone_id
    HAVING count(*) > 1
  ) d;

  IF v_dupes > 0 THEN
    RAISE WARNING
      'R-29: % Zone(s) are held by more than one open audit. The trigger refuses new ones; the unique index was not created. Close or cancel the older audits, then re-run this statement.',
      v_dupes;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS audit_zone_claimed_by_open_audit
      ON audit_zone (zone_id) WHERE audit_open;
  END IF;
END;
$mig$;

-- ------------------------------------------------------------- what the picker reads
--
-- The Zones of this audit's Unit that somebody else is holding, with the auditor's name.
-- Narrow in the same two ways `app_ensure_zone_for_audit` (0014) is: it answers only for
-- an audit the caller may see, and it says nothing about any other Unit. A Consultant
-- cannot read a colleague's `audit` row or `user` row, and this is deliberately the only
-- thing it tells them about one — that the Zone is taken, and by whom.
CREATE OR REPLACE FUNCTION app_zone_locks_for_audit(p_audit_id uuid)
-- The columns are prefixed because a plpgsql OUT parameter is a variable: one named
-- `audit_id` beside a query that joins `audit_zone` is an ambiguity waiting for the day
-- somebody writes an unqualified reference, and one named `audit_status` is also the name
-- of its own type.
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

REVOKE ALL ON FUNCTION app_zone_locks_for_audit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_zone_locks_for_audit(uuid) TO audit5s_app;
