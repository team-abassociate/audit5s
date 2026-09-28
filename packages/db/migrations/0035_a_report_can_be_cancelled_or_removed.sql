-- =============================================================================
-- 0035 — A report can be cancelled before it renders, or removed after
--
-- Nothing is deleted (D8): cancelling and removing are status changes, and who did it and
-- when are columns. RS-1 still holds for every byte a report *says* — payload, version,
-- target, checksum — and gains exactly one exit from READY:
--
--   READY | FAILED       → REMOVED     the PDF object is deleted, so `pdf_object_key` is
--                                      cleared with it; `pdf_checksum_sha256` stays as the
--                                      record of what was issued
--   QUEUED | RENDERING   → CANCELLED   nothing was issued
--
-- CANCELLED and REMOVED are terminal: no row leaves either, and the worker skips both.
-- =============================================================================

ALTER TABLE report_snapshot
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_by_user_id uuid REFERENCES "user"(id) ON DELETE RESTRICT;

COMMENT ON COLUMN report_snapshot.withdrawn_at IS
  'When the report was CANCELLED or REMOVED. NULL for every other status.';
COMMENT ON COLUMN report_snapshot.withdrawn_by_user_id IS
  'Who CANCELLED or REMOVED the report. NULL for every other status.';

-- Who and when, exactly when the status says it was withdrawn — never half filled in.
ALTER TABLE report_snapshot ADD CONSTRAINT report_snapshot_withdrawn CHECK (
  (status IN ('CANCELLED','REMOVED')) = (withdrawn_at IS NOT NULL AND withdrawn_by_user_id IS NOT NULL)
  AND (withdrawn_at IS NULL) = (withdrawn_by_user_id IS NULL)
);

-- A REMOVED report has no object: the download route never mints a URL to nothing.
ALTER TABLE report_snapshot ADD CONSTRAINT report_snapshot_removed CHECK (
  status <> 'REMOVED' OR pdf_object_key IS NULL
);

CREATE OR REPLACE FUNCTION enforce_report_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('CANCELLED','REMOVED') THEN
    RAISE EXCEPTION
      'Report snapshot % is % and final. Generate a new report instead',
      OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status = 'CANCELLED' AND OLD.status NOT IN ('QUEUED','RENDERING') THEN
    RAISE EXCEPTION
      'Report snapshot % is % — only a queued or rendering report can be cancelled',
      OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status = 'REMOVED' AND OLD.status NOT IN ('READY','FAILED') THEN
    RAISE EXCEPTION
      'Report snapshot % is % — only a rendered or failed report can be removed',
      OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'READY' THEN
    -- The one carve-out from RS-1: READY → REMOVED, changing nothing but the status, the
    -- object pointer (to NULL) and who withdrew it when. Everything the document said,
    -- including its checksum, stays exactly as issued.
    IF NEW.status <> 'REMOVED'
       OR (to_jsonb(NEW) - ARRAY['status','pdf_object_key','withdrawn_at','withdrawn_by_user_id','updated_at'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['status','pdf_object_key','withdrawn_at','withdrawn_by_user_id','updated_at'])
    THEN
      RAISE EXCEPTION
        'Report snapshot % is READY and immutable (RS-1). Regeneration inserts version %, '
        'it does not rewrite this one',
        OLD.id, OLD.version + 1
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.audit_zone_id IS DISTINCT FROM OLD.audit_zone_id
     OR NEW.selected_zone_ids IS DISTINCT FROM OLD.selected_zone_ids
     OR NEW.selected_audit_zone_ids IS DISTINCT FROM OLD.selected_audit_zone_ids
     OR NEW.assignment_group_id IS DISTINCT FROM OLD.assignment_group_id
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at THEN
    RAISE EXCEPTION
      'Report snapshot %: the frozen payload and what it is a report *of* never change '
      '(RS-1). A different document is a new version',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
