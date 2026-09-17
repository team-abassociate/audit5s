-- =============================================================================
-- 0015 — The typed Zone leader sticks
--
-- 0014 let the auditor name the Zone and type its leader's name. That name reached
-- `audit_zone.zone_leader_name_snapshot` and stopped there, so a Zone with no leader
-- *account* still read "Leader unassigned" on every dashboard — while the audit sitting
-- underneath it plainly carried the name the auditor had typed. The name was captured and
-- then never shown, which is how it read as the app having forgotten it.
--
-- Two halves:
--
--   1. `zone.zone_leader_name` — a free-text leader, for the Zones that have a person but
--      no user account. It is a *display* fallback and nothing else. Authorization has
--      never come from this pointer (C2: "a responsibility pointer, not a permission") and
--      a text column cannot start now — nothing anywhere joins on it.
--
--   2. `app_set_zone_leader_name()` — the write-back. `zone_update` (0005) admits only a
--      Coordinator or a Super Admin, and the auditor typing the name is neither, so the
--      write needs a definer function narrower than any policy: the caller's own open
--      audit, in their own Unit, for a Zone of that same Unit.
--
-- **The account always wins.** When `zone_leader_id` is set, the typed name is recorded on
-- the audit and the Zone row is left alone. A stand-in named during one audit must not
-- silently detach a properly assigned Zone Leader, and a typo must not be able to either.
-- This is the product owner's decision, taken deliberately over "always overwrite".
--
-- Past audits are untouched by design. `zone_leader_name_snapshot` is on `audit_zone` and
-- is what that audit found on that day (D6); this migration never rewrites one. An audit
-- conducted last month keeps last month's name even after a different name is typed today.
-- =============================================================================

ALTER TABLE zone ADD COLUMN IF NOT EXISTS zone_leader_name text;

COMMENT ON COLUMN zone.zone_leader_name IS
  'Display-only fallback leader name for Zones with no zone_leader_id account. Written by '
  'app_set_zone_leader_name() from the name an auditor types during an audit. Never used '
  'for authorization — see C2.';

-- -----------------------------------------------------------------------------
-- The write-back.
--
-- Returns the name now effective for the Zone, which is the account's name whenever one is
-- assigned. The service stores that on the audit snapshot, so the snapshot and the board
-- agree about who was named rather than diverging by which table they read.
--
-- Returns NULL when the audit is not the caller's, is closed, or the Zone belongs to a
-- different Unit — the same silence `app_ensure_zone_for_audit` (0014) answers with, and
-- the service reports it the same way.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_set_zone_leader_name(
  p_audit_id uuid,
  p_zone_id  uuid,
  p_name     text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_unit_id     uuid;
  v_leader_id   uuid;
  v_clean       text;
  v_account     text;
BEGIN
  v_clean := NULLIF(btrim(p_name), '');

  -- The caller's own audit, still open, inside one of the caller's Units. Identical to the
  -- test `app_ensure_zone_for_audit` applies, because it is the same permission: this is
  -- the auditor recording what they found while conducting that audit.
  SELECT a.unit_id INTO v_unit_id
  FROM audit a
  WHERE a.id = p_audit_id
    AND a.status IN ('ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED')
    AND (
      app_is_super_admin()
      OR (a.auditor_user_id = app_actor_id() AND a.unit_id = ANY (app_actor_unit_ids()))
    );

  IF v_unit_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- The Zone must belong to the audit's own Unit. Without this the function would write a
  -- name onto any Zone in the database given its id, which is exactly the cross-Unit write
  -- the threat model names.
  SELECT z.zone_leader_id INTO v_leader_id
  FROM zone z
  WHERE z.id = p_zone_id AND z.unit_id = v_unit_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- An assigned account outranks anything typed. Return its name and write nothing.
  IF v_leader_id IS NOT NULL THEN
    v_account := app_zone_leader_name(v_unit_id, v_leader_id);
    IF v_account IS NOT NULL THEN
      RETURN v_account;
    END IF;
    -- The pointer survives a membership that has since lapsed, so the account resolves to
    -- no name. The Zone then has no readable leader and the typed name is better than
    -- nothing — but the pointer itself is left in place for a Coordinator to settle.
  END IF;

  -- A blank name never erases one already recorded: an auditor who leaves the field empty
  -- is declining to answer, not asserting that the Zone has no leader.
  IF v_clean IS NULL THEN
    RETURN (SELECT z.zone_leader_name FROM zone z WHERE z.id = p_zone_id);
  END IF;

  -- `updated_at` is the trigger's job (0001), and `version` is deliberately not bumped:
  -- it guards the Coordinator's edit form, which cannot write this column at all. Bumping
  -- it here would reject a Coordinator's unrelated save with a stale-version error every
  -- time an auditor typed a name, for a field their form never touched.
  --
  -- The `IS DISTINCT FROM` guard keeps a re-synced audit from rewriting an identical value
  -- and moving `updated_at` for nothing.
  UPDATE zone
     SET zone_leader_name = v_clean
   WHERE id = p_zone_id
     AND zone_leader_name IS DISTINCT FROM v_clean;

  RETURN v_clean;
END;
$$;

REVOKE ALL ON FUNCTION app_set_zone_leader_name(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_zone_leader_name(uuid, uuid, text) TO audit5s_app;
