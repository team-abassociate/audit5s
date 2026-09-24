-- =============================================================================
-- 0029 — One audit of a Unit, conducted by several Consultants together
--
-- A Unit is often audited on one day by two or three Consultants who split its Zones
-- between them. Until now that was two or three unrelated assignments, and the unit
-- summary had no way to know they were one piece of work.
--
-- The grouping is a column, not a new kind of audit. Each Consultant still receives their
-- own assignment and conducts their own `audit` row on their own device, so D7's
-- single-writer lock and the outbox's one-device-owns-an-audit assumption (STACK.md §8)
-- are untouched: nobody ever edits an audit someone else's phone holds. What the group
-- adds is the sentence "these assignments were given together", which the summary report
-- reads to combine the Zones they covered.
--
-- `group_id` is shared by the assignments of one New-assignment action. A lone
-- assignment carries NULL — it is a group of one, and saying nothing about it keeps every
-- existing row true without a backfill.
--
-- A summary generated for a group records the group on its snapshot, so a regeneration
-- rebuilds the same combined audit rather than drifting to the Unit's latest Zones. The
-- column joins the RS-1 immutable set: what a report is *of* never changes after it is
-- written.
-- =============================================================================

ALTER TABLE audit_assignment
  ADD COLUMN group_id uuid;

CREATE INDEX audit_assignment_group_idx ON audit_assignment (group_id)
  WHERE group_id IS NOT NULL;

COMMENT ON COLUMN audit_assignment.group_id IS
  'Shared by assignments created together for one Unit audit by several auditors. NULL for '
  'an assignment created alone.';

ALTER TABLE report_snapshot
  ADD COLUMN assignment_group_id uuid;

COMMENT ON COLUMN report_snapshot.assignment_group_id IS
  'A summary of one multi-auditor audit: the audit_assignment.group_id whose Zones it '
  'combines. NULL for every other report.';

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
