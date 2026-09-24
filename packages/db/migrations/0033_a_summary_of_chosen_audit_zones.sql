-- =============================================================================
-- 0033 — A summary of audited Zones chosen one by one
--
-- A summary was chosen by **Zone**, and each Zone contributed its latest completed audit.
-- A Unit audited five times in a month could therefore only ever be summarised as "the
-- latest of each": there was no way to say "Zones 1 and 2 from the first audit, Zones 3, 4
-- and 5 from the second", which is how the Super Admin reads a month's work.
--
-- The selection can now be by **audited Zone** — an `audit_zone` row, which is one Zone
-- of one audit on one date. It is stored on the snapshot, as the Zone selection is, so a
-- regeneration rebuilds exactly the same document. It joins RS-1's immutable set: what a
-- report is *of* never changes after it is written.
-- =============================================================================

ALTER TABLE report_snapshot
  ADD COLUMN selected_audit_zone_ids uuid[];

COMMENT ON COLUMN report_snapshot.selected_audit_zone_ids IS
  'A summary of hand-picked audited Zones: the audit_zone ids it covers, possibly from '
  'several audits. NULL for every other report.';

-- 0010's target rule, taught the second way a summary names what it covers: by Zone, or by
-- audited Zone — exactly one of the two, and never an empty list. A Zone report names
-- neither.
ALTER TABLE report_snapshot DROP CONSTRAINT report_snapshot_target;
ALTER TABLE report_snapshot ADD CONSTRAINT report_snapshot_target CHECK (
  (kind IN ('INITIAL_ZONE','AFTER_EVIDENCE_ZONE')
     AND audit_zone_id IS NOT NULL AND audit_id IS NOT NULL
     AND selected_zone_ids IS NULL AND selected_audit_zone_ids IS NULL)
  OR (kind = 'MULTI_ZONE_SUMMARY'
     AND audit_zone_id IS NULL
     AND (
       (selected_zone_ids IS NOT NULL AND cardinality(selected_zone_ids) > 0
          AND selected_audit_zone_ids IS NULL)
       OR (selected_audit_zone_ids IS NOT NULL AND cardinality(selected_audit_zone_ids) > 0
          AND selected_zone_ids IS NULL)
     ))
);

CREATE OR REPLACE FUNCTION enforce_report_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'READY' THEN
    RAISE EXCEPTION
      'Report snapshot % is READY and immutable (RS-1). Regeneration inserts version %, '
      'it does not rewrite this one',
      OLD.id, OLD.version + 1
      USING ERRCODE = 'restrict_violation';
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
