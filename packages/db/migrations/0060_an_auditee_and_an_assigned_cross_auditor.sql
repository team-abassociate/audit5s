-- =============================================================================
-- 0060 — An audit records its auditee; a cross audit names who audits each Zone
--
-- Owner, 2026-10-31.
--
-- R-72: when a Zone Leader is away, someone else faces the audit of their Zone. The auditor
-- types who did (`audit_zone.auditee_name`) and photographs them (`AUDITEE_PHOTO`), as proof
-- for management. When the Zone Leader is there, they are the auditee.
--
-- R-73: a Coordinator calling a cross audit gives each Zone to one of the Unit's Zone Leaders
-- / Auditors (R-64). An assignment is its own append-only row, so `cross_audit_call` stays
-- append-only: giving the Zone to someone else is a new row, and the latest row for a call is
-- the one in force. A call with no row went to every Zone Leader, as before.
-- =============================================================================

-- Not used in this transaction, so ADD VALUE may run inside it (PostgreSQL 12+).
ALTER TYPE evidence_kind ADD VALUE IF NOT EXISTS 'AUDITEE_PHOTO';

ALTER TABLE audit_zone ADD COLUMN auditee_name text;

CREATE TABLE cross_audit_assignment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id              uuid NOT NULL REFERENCES cross_audit_call (id) ON DELETE RESTRICT,
  unit_id              uuid NOT NULL REFERENCES unit (id) ON DELETE RESTRICT,
  auditor_user_id      uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  assigned_by_user_id  uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cross_audit_assignment_call_idx ON cross_audit_assignment (call_id, created_at DESC);
CREATE INDEX cross_audit_assignment_auditor_idx ON cross_audit_assignment (auditor_user_id);

CREATE TRIGGER cross_audit_assignment_append_only BEFORE UPDATE OR DELETE ON cross_audit_assignment
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

ALTER TABLE cross_audit_assignment ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON cross_audit_assignment TO audit5s_app;

-- Read as the calls are: by everyone of the Unit.
CREATE POLICY cross_audit_assignment_select ON cross_audit_assignment FOR SELECT
  USING (app_is_super_admin() OR unit_id = ANY (app_actor_unit_ids()));

-- Made as the calls are: by the Unit's Coordinator or a Super Admin. Who may be assigned is
-- the API's rule: an active Zone Leader of the Unit.
CREATE POLICY cross_audit_assignment_insert ON cross_audit_assignment FOR INSERT
  WITH CHECK (
    assigned_by_user_id = app_actor_id()
    AND (app_is_super_admin()
         OR (app_actor_role() = 'COORDINATOR' AND unit_id = ANY (app_actor_unit_ids())))
  );
