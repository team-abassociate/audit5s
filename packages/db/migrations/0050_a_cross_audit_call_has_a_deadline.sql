-- =============================================================================
-- 0050 — A cross-audit call is a record, with a deadline
--
-- Owner, 2026-10-14: the Coordinator sets the date a called cross audit is due. The call
-- stands until anyone — any Zone Leader of the Unit, or the Coordinator — starts an audit
-- of its Zone; past the date it stays, marked overdue. Until now a call was only a
-- notification, which each phone aged out after seven days and answered from its own
-- audits, so one Zone Leader doing it left it standing for the others.
--
-- Append-only: a call is made once and never edited. Whether it is answered is read from
-- the audits, not written here.
-- =============================================================================

CREATE TABLE cross_audit_call (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id            uuid NOT NULL REFERENCES unit (id) ON DELETE RESTRICT,
  zone_id            uuid NOT NULL REFERENCES zone (id) ON DELETE RESTRICT,
  called_by_user_id  uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  -- Snapshotted, e.g. "Rahul Sharma (RA3210)", as the audit log does.
  called_by_label    text NOT NULL,
  -- A calendar date in the Unit's day, not an instant: "due by 18 Oct".
  due_on             date NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cross_audit_call_unit_idx ON cross_audit_call (unit_id, created_at DESC);

CREATE TRIGGER cross_audit_call_append_only BEFORE UPDATE OR DELETE ON cross_audit_call
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

ALTER TABLE cross_audit_call ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON cross_audit_call TO audit5s_app;

-- Everyone of the Unit reads its calls: the Zone Leaders answer them, the Coordinator made them.
CREATE POLICY cross_audit_call_select ON cross_audit_call FOR SELECT
  USING (app_is_super_admin() OR unit_id = ANY (app_actor_unit_ids()));

CREATE POLICY cross_audit_call_insert ON cross_audit_call FOR INSERT
  WITH CHECK (
    called_by_user_id = app_actor_id()
    AND (app_is_super_admin()
         OR (app_actor_role() = 'COORDINATOR' AND unit_id = ANY (app_actor_unit_ids())))
  );

-- The calls already made that name a Zone, from the audit log, due seven days after they
-- were made — what the phones showed until now. Calls that named no Zone are not carried.
INSERT INTO cross_audit_call (unit_id, zone_id, called_by_user_id, called_by_label, due_on, created_at)
SELECT l.unit_id, (l.after ->> 'zoneId')::uuid, l.actor_user_id, l.actor_label,
       (l.occurred_at AT TIME ZONE 'UTC')::date + 7, l.occurred_at
FROM audit_log l
JOIN zone z ON z.id = (l.after ->> 'zoneId')::uuid
WHERE l.action = 'unit.cross_audit_called'
  AND l.unit_id IS NOT NULL
  AND l.actor_user_id IS NOT NULL;
