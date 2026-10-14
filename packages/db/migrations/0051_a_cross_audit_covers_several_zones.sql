-- =============================================================================
-- 0051 — A cross audit covers several Zones, and the Coordinator may close it
--
-- Owner, 2026-10-14: a Coordinator calls one cross audit of many Zones at once (or all of
-- them), sees it as one card — which Zones are waiting, under way, done — moves its date
-- as often as the Zone Leaders need, and may complete it with a remark even when a Zone
-- was never audited.
--
-- A `cross_audit_round` is that one call; `cross_audit_call` keeps a row per Zone. The
-- round's `due_on` is the deadline in force (the call's own `due_on` is what was first
-- asked). A completed round's calls no longer stand for any Zone Leader.
-- =============================================================================

CREATE TABLE cross_audit_round (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id               uuid NOT NULL REFERENCES unit (id) ON DELETE RESTRICT,
  called_by_user_id     uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  called_by_label       text NOT NULL,
  due_on                date NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  completed_by_user_id  uuid REFERENCES "user" (id) ON DELETE RESTRICT,
  completed_by_label    text,
  completion_remark     text,
  CONSTRAINT cross_audit_round_completed_by CHECK ((completed_at IS NULL) = (completed_by_user_id IS NULL))
);

CREATE INDEX cross_audit_round_unit_idx ON cross_audit_round (unit_id, created_at DESC);

ALTER TABLE cross_audit_round ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON cross_audit_round TO audit5s_app;
-- The deadline moves and the round completes; nothing else about it changes.
GRANT UPDATE (due_on, completed_at, completed_by_user_id, completed_by_label, completion_remark)
  ON cross_audit_round TO audit5s_app;

CREATE POLICY cross_audit_round_select ON cross_audit_round FOR SELECT
  USING (app_is_super_admin() OR unit_id = ANY (app_actor_unit_ids()));

CREATE POLICY cross_audit_round_insert ON cross_audit_round FOR INSERT
  WITH CHECK (
    called_by_user_id = app_actor_id()
    AND (app_is_super_admin()
         OR (app_actor_role() = 'COORDINATOR' AND unit_id = ANY (app_actor_unit_ids())))
  );

CREATE POLICY cross_audit_round_update ON cross_audit_round FOR UPDATE
  USING (app_is_super_admin()
         OR (app_actor_role() = 'COORDINATOR' AND unit_id = ANY (app_actor_unit_ids())));

-- Every call made so far becomes a round of its own Zone, sharing the call's id.
INSERT INTO cross_audit_round (id, unit_id, called_by_user_id, called_by_label, due_on, created_at)
SELECT id, unit_id, called_by_user_id, called_by_label, due_on, created_at FROM cross_audit_call;

ALTER TABLE cross_audit_call ADD COLUMN round_id uuid REFERENCES cross_audit_round (id) ON DELETE RESTRICT;
-- The one write this append-only table ever takes: pointing the old calls at their rounds.
DROP TRIGGER cross_audit_call_append_only ON cross_audit_call;
UPDATE cross_audit_call SET round_id = id;
CREATE TRIGGER cross_audit_call_append_only BEFORE UPDATE OR DELETE ON cross_audit_call
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();
ALTER TABLE cross_audit_call ALTER COLUMN round_id SET NOT NULL;
CREATE INDEX cross_audit_call_round_idx ON cross_audit_call (round_id);
