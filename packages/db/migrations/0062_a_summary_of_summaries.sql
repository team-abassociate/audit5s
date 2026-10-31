-- =============================================================================
-- 0062 — A summary of summaries (R-75)
--
-- Management reviews months of audits without opening every summary. A TREND_SUMMARY puts
-- the chosen audits side by side — the overall score, each S and the 5S web of each — in
-- one of two ways, and the snapshot records which, so a regeneration rebuilds the same
-- document:
--
--   * **Zone-wise**: finished audits of one Zone, named by their `audit_zone` ids in
--     `selected_audit_zone_ids` (0033's column, the same meaning);
--   * **Unit-wise**: Summary reports already issued for the Unit, named in the new
--     `selected_snapshot_ids`. Each point is what that summary printed, read from its
--     frozen payload, so the trend agrees with the documents management already holds.
--
-- There is no upper bound on either list: how many audits to compare is the Super Admin's
-- call. Both lists join RS-1's immutable set.
-- =============================================================================

ALTER TABLE report_snapshot
  ADD COLUMN selected_snapshot_ids uuid[];

COMMENT ON COLUMN report_snapshot.selected_snapshot_ids IS
  'A unit-wise summary of summaries: the MULTI_ZONE_SUMMARY snapshots it compares. NULL for '
  'every other report.';

-- 0033's target rule, taught the summary of summaries: no Zone, no Zone selection, and
-- exactly one non-empty list of what it compares.
ALTER TABLE report_snapshot DROP CONSTRAINT report_snapshot_target;
ALTER TABLE report_snapshot ADD CONSTRAINT report_snapshot_target CHECK (
  (kind IN ('INITIAL_ZONE','AFTER_EVIDENCE_ZONE')
     AND audit_zone_id IS NOT NULL AND audit_id IS NOT NULL
     AND selected_zone_ids IS NULL AND selected_audit_zone_ids IS NULL
     AND selected_snapshot_ids IS NULL)
  OR (kind = 'MULTI_ZONE_SUMMARY'
     AND audit_zone_id IS NULL AND selected_snapshot_ids IS NULL
     AND (
       (selected_zone_ids IS NOT NULL AND cardinality(selected_zone_ids) > 0
          AND selected_audit_zone_ids IS NULL)
       OR (selected_audit_zone_ids IS NOT NULL AND cardinality(selected_audit_zone_ids) > 0
          AND selected_zone_ids IS NULL)
     ))
  OR (kind = 'TREND_SUMMARY'
     AND audit_zone_id IS NULL AND selected_zone_ids IS NULL
     AND (
       (selected_audit_zone_ids IS NOT NULL AND cardinality(selected_audit_zone_ids) > 0
          AND selected_snapshot_ids IS NULL)
       OR (selected_snapshot_ids IS NOT NULL AND cardinality(selected_snapshot_ids) > 0
          AND selected_audit_zone_ids IS NULL)
     ))
);

-- 0035's function, with the new list frozen beside the others.
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
     OR NEW.selected_snapshot_ids IS DISTINCT FROM OLD.selected_snapshot_ids
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
