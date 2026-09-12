-- Phase 8 analytics. Rollups are derived caches: every value is reproducible from audit data.

CREATE TABLE metric_daily_unit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES unit(id) ON DELETE RESTRICT,
  day date NOT NULL,
  audit_count integer NOT NULL DEFAULT 0,
  completed_count integer NOT NULL DEFAULT 0,
  raw_score integer NOT NULL DEFAULT 0,
  max_score integer NOT NULL DEFAULT 0,
  avg_score numeric(6,3) NULL,
  score_sample_count integer NOT NULL DEFAULT 0,
  open_nc integer NOT NULL DEFAULT 0,
  closed_nc integer NOT NULL DEFAULT 0,
  avg_closure_hours numeric(12,3) NULL,
  active_auditors integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metric_daily_unit_nonnegative CHECK (
    audit_count >= 0 AND completed_count >= 0 AND raw_score >= 0 AND max_score >= 0
    AND score_sample_count >= 0 AND open_nc >= 0 AND closed_nc >= 0 AND active_auditors >= 0
  )
);
CREATE UNIQUE INDEX metric_daily_unit_key ON metric_daily_unit (unit_id, day);
CREATE INDEX metric_daily_unit_unit_day_idx ON metric_daily_unit (unit_id, day);

CREATE TABLE metric_daily_zone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES unit(id) ON DELETE RESTRICT,
  zone_id uuid NOT NULL REFERENCES zone(id) ON DELETE RESTRICT,
  day date NOT NULL,
  audit_count integer NOT NULL DEFAULT 0,
  raw_score integer NOT NULL DEFAULT 0,
  max_score integer NOT NULL DEFAULT 0,
  last_score numeric(6,3) NULL,
  avg_score numeric(6,3) NULL,
  score_sample_count integer NOT NULL DEFAULT 0,
  open_nc integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metric_daily_zone_nonnegative CHECK (
    audit_count >= 0 AND raw_score >= 0 AND max_score >= 0
    AND score_sample_count >= 0 AND open_nc >= 0
  )
);
CREATE UNIQUE INDEX metric_daily_zone_key ON metric_daily_zone (zone_id, day);
CREATE INDEX metric_daily_zone_zone_day_idx ON metric_daily_zone (zone_id, day);
CREATE INDEX metric_daily_zone_unit_day_idx ON metric_daily_zone (unit_id, day);

CREATE TABLE metric_section_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL REFERENCES unit(id) ON DELETE RESTRICT,
  zone_id uuid NOT NULL REFERENCES zone(id) ON DELETE RESTRICT,
  section s_section NOT NULL,
  day date NOT NULL,
  raw_score integer NOT NULL DEFAULT 0,
  max_score integer NOT NULL DEFAULT 0,
  avg_score_percentage numeric(6,3) NULL,
  sample_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metric_section_daily_nonnegative CHECK (
    raw_score >= 0 AND max_score >= 0 AND sample_count >= 0
  )
);
CREATE UNIQUE INDEX metric_section_daily_key
  ON metric_section_daily (unit_id, zone_id, section, day);
CREATE INDEX metric_section_daily_unit_day_idx ON metric_section_daily (unit_id, day);
CREATE INDEX metric_section_daily_zone_day_idx ON metric_section_daily (zone_id, day);

-- §11.3. Several already shipped with their source tables; IF NOT EXISTS keeps 0011 additive.
CREATE INDEX IF NOT EXISTS audit_unit_status_completed_idx
  ON audit (unit_id, status, completed_at DESC);
CREATE INDEX IF NOT EXISTS audit_auditor_completed_idx
  ON audit (auditor_user_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS audit_unit_type_completed_idx
  ON audit (unit_id, audit_type, completed_at DESC);
CREATE INDEX IF NOT EXISTS audit_zone_zone_completed_idx
  ON audit_zone (zone_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS audit_zone_section_score_zone_section_idx
  ON audit_zone_section_score (audit_zone_id, section);
CREATE INDEX IF NOT EXISTS question_response_question_value_idx
  ON question_response (checklist_question_id, value);
CREATE INDEX IF NOT EXISTS corrective_action_unit_status_idx
  ON corrective_action (unit_id, status);
CREATE INDEX IF NOT EXISTS corrective_action_assignee_status_idx
  ON corrective_action (assigned_zone_leader_user_id, status);
CREATE INDEX IF NOT EXISTS corrective_action_zone_opened_idx
  ON corrective_action (zone_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS corrective_action_overdue_idx
  ON corrective_action (status, due_at) WHERE status IN ('OPEN','REOPENED');
CREATE INDEX audit_log_occurred_brin ON audit_log USING brin (occurred_at);

CREATE TRIGGER metric_daily_unit_updated_at BEFORE UPDATE ON metric_daily_unit
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER metric_daily_zone_updated_at BEFORE UPDATE ON metric_daily_zone
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER metric_section_daily_updated_at BEFORE UPDATE ON metric_section_daily
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER metric_daily_unit_no_delete BEFORE DELETE ON metric_daily_unit
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();
CREATE TRIGGER metric_daily_zone_no_delete BEFORE DELETE ON metric_daily_zone
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();
CREATE TRIGGER metric_section_daily_no_delete BEFORE DELETE ON metric_section_daily
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

ALTER TABLE metric_daily_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_daily_zone ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_section_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY metric_daily_unit_select ON metric_daily_unit FOR SELECT
  USING (app_is_super_admin() OR unit_id = ANY (app_actor_unit_ids()));
CREATE POLICY metric_daily_zone_select ON metric_daily_zone FOR SELECT
  USING (app_is_super_admin() OR unit_id = ANY (app_actor_unit_ids()));
CREATE POLICY metric_section_daily_select ON metric_section_daily FOR SELECT
  USING (app_is_super_admin() OR unit_id = ANY (app_actor_unit_ids()));

-- The rollup worker runs this narrow derived-data write as the system SUPER_ADMIN role.
CREATE POLICY metric_daily_unit_write ON metric_daily_unit FOR INSERT
  WITH CHECK (app_is_super_admin());
CREATE POLICY metric_daily_unit_update ON metric_daily_unit FOR UPDATE
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());
CREATE POLICY metric_daily_zone_write ON metric_daily_zone FOR INSERT
  WITH CHECK (app_is_super_admin());
CREATE POLICY metric_daily_zone_update ON metric_daily_zone FOR UPDATE
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());
CREATE POLICY metric_section_daily_write ON metric_section_daily FOR INSERT
  WITH CHECK (app_is_super_admin());
CREATE POLICY metric_section_daily_update ON metric_section_daily FOR UPDATE
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());

GRANT SELECT, INSERT, UPDATE ON metric_daily_unit, metric_daily_zone, metric_section_daily
  TO audit5s_app;
