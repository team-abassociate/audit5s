-- =============================================================================
-- 0055 — An audit keeps the Zone label it was taken under (DECISIONS.md R-60)
--
-- Owner, 2026-10-26. Withdraws R-52's "a rename reaches history" (0048). An auditor
-- reports Zone 1 today; a fortnight later the Unit renumbers it Zone 7 — by hand or by
-- importing a Zone list (R-59) — while its corrective actions are still open. Relabelling
-- that audit would leave the Zone Leader, the auditor and the Super Admin looking at a
-- report and actions that no longer say what was audited. So an audit Zone's code and name
-- snapshot are D6's again: written when the Zone joins the audit, never rewritten by a
-- change to the Unit's Zone. Corrective actions and reports already read the snapshot, so
-- they follow; a regenerated report prints what the audit recorded.
--
-- The trigger that relabelled audits is dropped, and the append-only guard loses the
-- carve-out that admitted it — 0021's guard again, so nothing may rewrite those two
-- columns on a finished audit. Audits relabelled while 0048 was live are not changed back
-- here: the audit log holds each rename's before and after if one must be restored.
-- =============================================================================

DROP TRIGGER IF EXISTS zone_relabels_its_audits ON zone;
DROP FUNCTION IF EXISTS app_relabel_audit_zones();

-- 0021's guard, as 0048 had it but without the R-52 carve-out.
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
