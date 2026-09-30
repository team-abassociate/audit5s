-- =============================================================================
-- 0038 — Overall corrective-action suggestions for a Zone (DECISIONS.md R-38)
--
-- After the fiftieth question the auditor writes an overall remark, and may now also
-- write any number of **overall corrective-action suggestions** for the Zone as a whole —
-- the things no photograph can show: a smell, a habit, a missing routine. None is
-- required to complete the Zone.
--
-- Each suggestion becomes a corrective action when the audit completes, exactly as each
-- nonconformity photograph does, so it gets the same signed link in the report, the same
-- notifications, the same roll-up and the same place in the Zone Leader's list. What is
-- different is what it answers and how it may be answered:
--
--   * **It answers a sentence, not a photograph.** `corrective_action.evidence_id` becomes
--     nullable, and a row carries exactly one of `evidence_id` (a finding) or `suggestion`
--     (an overall action). `suggestion_no` is its 1-based place in the Zone's list, and
--     `(audit_zone_id, suggestion_no)` is unique — the same "one action per source, and
--     completing twice raises nothing twice" guarantee `UNIQUE(evidence_id)` gives a
--     finding.
--   * **The after-photo is optional, and may come from the gallery.** A stink cannot be
--     photographed. CA-2's "Option A needs an after-photo" CHECK moves into the trigger,
--     which can see the action: a finding still needs a live after-photo; an overall action
--     needs only its description, and a photo it does carry need not be a live capture.
-- =============================================================================

-- --- audit_zone: what the auditor wrote --------------------------------------

ALTER TABLE audit_zone
  ADD COLUMN overall_action_suggestions text[] NOT NULL DEFAULT '{}';

ALTER TABLE audit_zone
  ADD CONSTRAINT audit_zone_overall_action_suggestions_bounded CHECK (
    cardinality(overall_action_suggestions) <= 20
  );

COMMENT ON COLUMN audit_zone.overall_action_suggestions IS
  'Overall corrective-action suggestions for the Zone, in the auditor''s order (R-38). Each becomes a corrective action at completion. Empty when there are none.';

-- --- corrective_action: a finding, or an overall suggestion ------------------

ALTER TABLE corrective_action ALTER COLUMN evidence_id DROP NOT NULL;

ALTER TABLE corrective_action
  ADD COLUMN suggestion    text    NULL,
  ADD COLUMN suggestion_no integer NULL;

ALTER TABLE corrective_action
  ADD CONSTRAINT corrective_action_one_source CHECK (
    (evidence_id IS NULL) = (suggestion IS NOT NULL)
    AND (suggestion IS NULL) = (suggestion_no IS NULL)
    AND (suggestion IS NULL OR btrim(suggestion) <> '')
    AND (suggestion_no IS NULL OR suggestion_no >= 1)
  );

-- One action per suggestion, as `corrective_action_evidence_key` is one per photograph.
CREATE UNIQUE INDEX corrective_action_suggestion_key
  ON corrective_action (audit_zone_id, suggestion_no) WHERE suggestion_no IS NOT NULL;

-- --- corrective_action_submission: CA-2 reads the action now -----------------

-- "Option A needs a description" stays a CHECK. "…and an after-photo" cannot: whether a
-- photo is required depends on the action, which a CHECK cannot read.
ALTER TABLE corrective_action_submission
  DROP CONSTRAINT corrective_action_submission_ca2_completed;

ALTER TABLE corrective_action_submission
  ADD CONSTRAINT corrective_action_submission_ca2_completed CHECK (
    option <> 'COMPLETED' OR btrim(COALESCE(description, '')) <> ''
  );

/*
 * CA-2, read against the action (R-38).
 *
 * A **finding** answered as done still needs an after-photo that is a live capture, taken
 * for this action and this attempt — unchanged from 0009. An **overall action** answered
 * as done needs none; a photo it does cite must still belong to this action and attempt,
 * and may have come from the gallery.
 */
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

  SELECT e.kind, e.is_live_capture, e.corrective_action_id,
         e.corrective_action_submission_id, e.deleted_at
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

  IF is_finding AND NOT photo.is_live_capture THEN
    RAISE EXCEPTION
      'Evidence % was not a live capture; Option A requires one (CA-2, 12.10)',
      NEW.after_evidence_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
