-- =============================================================================
-- 0040 — A finding's after-photo may come from the gallery (DECISIONS.md R-40)
--
-- The product owner widened R-38's gallery to every corrective action: the link page
-- offers *Choose from gallery* beside *Open the camera* for a finding too. CA-2's
-- live-capture half is therefore waived for findings, as 0038 waived it for overall
-- actions, and `enforce_submission_after_evidence()` loses its last `is_live_capture`
-- test. Everything else it checks stands:
--
--   * a finding answered as done still needs an after-photo;
--   * a cited photo must be a CORRECTIVE_AFTER taken for this action and this attempt,
--     and not withdrawn.
--
-- `evidence.is_live_capture` is still stored as the client declared it, so the record
-- says honestly which photographs came from the gallery.
-- =============================================================================

CREATE OR REPLACE FUNCTION enforce_submission_after_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  photo record;
  is_finding boolean;
BEGIN
  SELECT ca.evidence_id IS NOT NULL INTO is_finding
    FROM corrective_action ca WHERE ca.id = NEW.corrective_action_id;

  IF NEW.after_evidence_id IS NULL THEN
    IF NEW.option = 'COMPLETED' AND is_finding THEN
      RAISE EXCEPTION
        'Corrective action % answers a photograph; Option A needs an after-photo (CA-2)',
        NEW.corrective_action_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT e.kind, e.corrective_action_id, e.corrective_action_submission_id, e.deleted_at
    INTO photo
    FROM evidence e WHERE e.id = NEW.after_evidence_id;

  IF photo.kind IS DISTINCT FROM 'CORRECTIVE_AFTER'
     OR photo.corrective_action_id IS DISTINCT FROM NEW.corrective_action_id
     OR photo.corrective_action_submission_id IS DISTINCT FROM NEW.id
     OR photo.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Evidence % is not an after-photo taken for corrective action % attempt % (CA-2)',
      NEW.after_evidence_id, NEW.corrective_action_id, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
