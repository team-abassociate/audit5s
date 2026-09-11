-- =============================================================================
-- 0005_zones_and_checklists
--
-- Phase 2 schema (ARCHITECTURE.md PART 14): Zones, the checklist model with its
-- versioning, and the six-stage Excel import.
--
-- Tables: zone, checklist_template, checklist_version, checklist_question,
--         checklist_import_job, checklist_import_sheet, checklist_import_row.
--
-- Two invariants are enforced here rather than only in the application, because both
-- are guarantees historical audits depend on:
--
--   * Z-1 — `zone.unit_id` is immutable. Moving a Zone between Units would silently
--     rewrite every historical Unit trend.
--   * CV-1 — a PUBLISHED checklist version and its questions are immutable. This is
--     what makes a two-year-old audit still readable, so it gets defence in depth: a
--     trigger that raises, not merely a service that declines.
--
-- Like every migration here, RLS policies and the triggers ship *with* the tables they
-- protect. There is never a window in which real data sits behind an unenforced rule.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums (ARCHITECTURE.md §5.1), added alongside the tables that reference them.
-- -----------------------------------------------------------------------------
CREATE TYPE s_section AS ENUM
  ('S1_SORT','S2_SET_IN_ORDER','S3_SHINE','S4_STANDARDIZE','S5_SUSTAIN');

CREATE TYPE checklist_version_status AS ENUM
  ('DRAFT','PUBLISHED','SUPERSEDED','ARCHIVED');

CREATE TYPE import_job_status AS ENUM
  ('UPLOADED','VALIDATING','PREVIEW','FAILED','COMMITTED','CANCELLED');

-- =============================================================================
-- Zones
-- =============================================================================

CREATE TABLE zone (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id                        uuid        NOT NULL REFERENCES unit(id) ON DELETE RESTRICT,
  -- Unique per Unit, not globally: two plants may both call a Zone Z-01.
  code                           text        NOT NULL,
  name                           text        NOT NULL,
  -- Freely editable. History is protected by the AuditZone snapshot (D6), not by
  -- freezing this row, so a Coordinator correcting a description is never blocked.
  description                    text        NULL,
  department_hint                text        NULL,
  default_checklist_template_id  uuid        NULL,
  -- A responsibility pointer, NOT a permission (C2). Access comes from unit_membership.
  zone_leader_id                 uuid        NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  sort_order                     integer     NOT NULL DEFAULT 0,
  version                        integer     NOT NULL DEFAULT 1,
  -- Archived Zones vanish from dropdowns and remain in history.
  archived_at                    timestamptz NULL,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX zone_unit_code_key ON zone (unit_id, code);
-- The Zone dropdown source: active Zones of one Unit, in display order.
CREATE INDEX zone_unit_active_sort_idx ON zone (unit_id, archived_at, sort_order);
CREATE INDEX zone_leader_idx ON zone (zone_leader_id);

CREATE TRIGGER zone_set_updated_at BEFORE UPDATE ON zone
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Invariant Z-1, as a database guarantee.
CREATE OR REPLACE FUNCTION enforce_zone_unit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN
    RAISE EXCEPTION
      'Zone %: unit_id is immutable (invariant Z-1); moving a Zone would rewrite Unit history',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER zone_unit_immutable
  BEFORE UPDATE OF unit_id ON zone
  FOR EACH ROW EXECUTE FUNCTION enforce_zone_unit_immutable();

/*
 * Whether a Zone is mid-audit, which is what blocks archiving it (§8.4 → 409
 * ZONE_HAS_IN_PROGRESS_AUDIT).
 *
 * `audit_zone` arrives with the audit engine in Phase 3, so today the answer is always
 * false — there is nothing that could be in progress. It is a function rather than an
 * inline query precisely so Phase 3 replaces one body here instead of hunting for the
 * places that ask, and so the API's guard is real code from the first day rather than a
 * branch nobody executes.
 */
CREATE OR REPLACE FUNCTION zone_has_in_progress_audit(target_zone_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM target_zone_id;
  RETURN false;
END;
$$;

-- =============================================================================
-- Checklists
--
-- Organization-wide reference data (D2): no Unit column anywhere in this section. That
-- is why PART 6 grants every role read access and why a device may cache the lot.
-- =============================================================================

CREATE TABLE checklist_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Derived from the workbook sheet name, e.g. `Stores (RM)` -> STORES_RM (R-6a).
  code        text        NOT NULL,
  -- The department. The sheet name is authoritative, not the upper-cased A1 title.
  name        text        NOT NULL,
  description text        NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  -- Workbook order, so the catalogue lists departments as the business lists them.
  sort_order  integer     NOT NULL DEFAULT 0,
  archived_at timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX checklist_template_code_key ON checklist_template (code);
CREATE INDEX checklist_template_sort_idx ON checklist_template (sort_order, name);

CREATE TRIGGER checklist_template_set_updated_at BEFORE UPDATE ON checklist_template
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE zone
  ADD CONSTRAINT zone_default_checklist_template_fk
  FOREIGN KEY (default_checklist_template_id)
  REFERENCES checklist_template(id) ON DELETE RESTRICT;

CREATE TABLE checklist_version (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id             uuid    NOT NULL REFERENCES checklist_template(id) ON DELETE RESTRICT,
  version_number          integer NOT NULL,
  status                  checklist_version_status NOT NULL DEFAULT 'DRAFT',
  -- A1, confirmed against the real workbook: five sections of ten.
  questions_per_section   integer NOT NULL DEFAULT 10,
  total_questions         integer NOT NULL,
  published_at            timestamptz NULL,
  published_by_user_id    uuid    NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  superseded_at           timestamptz NULL,
  superseded_by_version_id uuid   NULL REFERENCES checklist_version(id) ON DELETE RESTRICT,
  -- Provenance back to the uploaded workbook. Set for every imported version.
  source_import_job_id    uuid    NULL,
  -- SHA-256 over the ordered question set: the stage 4 duplicate check.
  content_hash            text    NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- Invariant CQ-1's arithmetic half. The 10-per-section half is checked by the
  -- importer and by the unique index on (version_id, section, order_in_section).
  CONSTRAINT checklist_version_shape
    CHECK (total_questions = 5 * questions_per_section AND questions_per_section > 0)
);

CREATE UNIQUE INDEX checklist_version_template_number_key
  ON checklist_version (template_id, version_number);

-- At most one PUBLISHED version per template, at any instant. This is the constraint
-- that makes "the current checklist for Production" a well-defined phrase.
CREATE UNIQUE INDEX checklist_version_one_published
  ON checklist_version (template_id) WHERE status = 'PUBLISHED';

-- Stage 4: the same content cannot be stored twice under one template.
CREATE UNIQUE INDEX checklist_version_content_key
  ON checklist_version (template_id, content_hash);

CREATE INDEX checklist_version_status_idx ON checklist_version (status);

CREATE TRIGGER checklist_version_set_updated_at BEFORE UPDATE ON checklist_version
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE checklist_question (
  id                                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id                           uuid      NOT NULL
                                         REFERENCES checklist_version(id) ON DELETE RESTRICT,
  section                              s_section NOT NULL,
  order_in_section                     integer   NOT NULL,
  -- The workbook's `Sr.`. Not a generated column: `questions_per_section` is per-version,
  -- so the arithmetic that ties the two together belongs with the importer, which
  -- validates the agreement row by row (§8.5 stage 3). The bounds are checked here.
  global_order                         integer   NOT NULL,
  text                                 text      NOT NULL,
  guidance                             text      NULL,
  allows_na                            boolean   NOT NULL DEFAULT true,
  requires_evidence_on_nonconformity   boolean   NOT NULL DEFAULT false,
  created_at                           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT checklist_question_order_positive CHECK (order_in_section >= 1),
  CONSTRAINT checklist_question_global_positive CHECK (global_order >= 1),
  CONSTRAINT checklist_question_text_length CHECK (char_length(text) BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX checklist_question_position_key
  ON checklist_question (version_id, section, order_in_section);
CREATE UNIQUE INDEX checklist_question_global_key
  ON checklist_question (version_id, global_order);
CREATE INDEX checklist_question_version_order_idx
  ON checklist_question (version_id, global_order);

/*
 * Invariant CV-1 — publish-time immutability.
 *
 * Once a version is PUBLISHED, neither it nor its questions may change. The single
 * carve-out is supersession: publishing v2 must be able to mark v1 SUPERSEDED, and
 * deactivation must be able to mark it ARCHIVED. Those three columns, and nothing else.
 *
 * The shape mirrors `enforce_append_only`: a named, explicit carve-out beside the rule
 * it bends, so there is never an UPDATE path that quietly rewrites a published question.
 */
CREATE OR REPLACE FUNCTION enforce_published_version_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed_columns text[] := ARRAY['status','superseded_at','superseded_by_version_id','updated_at'];
  changed_column  text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION
        'Checklist version % is %: a version that has been published is never deleted (CV-1)',
        OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  FOR changed_column IN
    SELECT key
    FROM jsonb_each(to_jsonb(OLD)) AS o(key, value)
    WHERE o.value IS DISTINCT FROM (to_jsonb(NEW) -> o.key)
  LOOP
    IF NOT (changed_column = ANY (allowed_columns)) THEN
      RAISE EXCEPTION
        'Checklist version % is %: column % may not be updated (CV-1)',
        OLD.id, OLD.status, changed_column
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;

  IF OLD.status = 'PUBLISHED' AND NEW.status NOT IN ('PUBLISHED','SUPERSEDED','ARCHIVED') THEN
    RAISE EXCEPTION
      'Checklist version %: PUBLISHED may only move to SUPERSEDED or ARCHIVED, not % (CV-1)',
      OLD.id, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER checklist_version_immutable_when_published
  BEFORE UPDATE OR DELETE ON checklist_version
  FOR EACH ROW EXECUTE FUNCTION enforce_published_version_immutable();

/*
 * The other half of CV-1: the questions.
 *
 * A published version whose *questions* could still be edited would be immutability in
 * name only, so the question trigger reads the parent's status rather than trusting the
 * caller to have checked it.
 */
CREATE OR REPLACE FUNCTION enforce_published_question_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_version uuid := CASE TG_OP WHEN 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  parent_status  checklist_version_status;
BEGIN
  SELECT v.status INTO parent_status FROM checklist_version v WHERE v.id = target_version;

  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION
      'Checklist version % is %: its questions are immutable (CV-1)',
      target_version, COALESCE(parent_status::text, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- INSERT is included: a question may only be added while its version is still a draft,
-- so nothing can be appended to a published checklist after the fact.
CREATE TRIGGER checklist_question_immutable_when_published
  BEFORE INSERT OR UPDATE OR DELETE ON checklist_question
  FOR EACH ROW EXECUTE FUNCTION enforce_published_question_immutable();

-- =============================================================================
-- Excel import (§8.5)
--
-- The real workbook is nine department sheets in one file (R-6a), so a job fans out to
-- sheets and each sheet becomes one template version. `checklist_import_sheet` is that
-- middle level; it carries the per-sheet duplicate verdict and the version it committed.
-- =============================================================================

CREATE TABLE checklist_import_job (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by_user_id     uuid    NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  file_name               text    NOT NULL,
  file_object_key         text    NOT NULL,
  file_checksum           text    NOT NULL,
  file_byte_size          integer NOT NULL,
  status                  import_job_status NOT NULL DEFAULT 'UPLOADED',
  sheet_count             integer NOT NULL DEFAULT 0,
  parsed_row_count        integer NOT NULL DEFAULT 0,
  error_count             integer NOT NULL DEFAULT 0,
  warning_count           integer NOT NULL DEFAULT 0,
  -- Stage 5 is a dry run that expires: a preview nobody committed must not be
  -- committable a month later against a checklist that has moved on.
  preview_expires_at      timestamptz NULL,
  error_report_object_key text    NULL,
  -- Sheets in the file that are not checklists, with the reason. The workbook's three
  -- legacy planning tabs land here (Q7), so "why is Production missing" is answerable.
  skipped_sheets          jsonb   NOT NULL DEFAULT '[]'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX checklist_import_job_status_idx ON checklist_import_job (status, preview_expires_at);
CREATE INDEX checklist_import_job_uploader_idx
  ON checklist_import_job (uploaded_by_user_id, created_at DESC);

CREATE TRIGGER checklist_import_job_set_updated_at BEFORE UPDATE ON checklist_import_job
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE checklist_version
  ADD CONSTRAINT checklist_version_source_job_fk
  FOREIGN KEY (source_import_job_id)
  REFERENCES checklist_import_job(id) ON DELETE RESTRICT;

CREATE TABLE checklist_import_sheet (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   uuid    NOT NULL
                             REFERENCES checklist_import_job(id) ON DELETE CASCADE,
  sheet_name               text    NOT NULL,
  sheet_index              integer NOT NULL,
  template_code            text    NOT NULL,
  template_name            text    NOT NULL,
  -- NULL means this sheet would create a new template.
  template_id              uuid    NULL REFERENCES checklist_template(id) ON DELETE RESTRICT,
  content_hash             text    NOT NULL,
  question_count           integer NOT NULL DEFAULT 0,
  severity                 text    NOT NULL DEFAULT 'OK'
                             CHECK (severity IN ('OK','WARNING','ERROR')),
  duplicate_of_version_id  uuid    NULL REFERENCES checklist_version(id) ON DELETE RESTRICT,
  duplicate_is_published   boolean NOT NULL DEFAULT false,
  committed_version_id     uuid    NULL REFERENCES checklist_version(id) ON DELETE RESTRICT,
  messages                 text[]  NOT NULL DEFAULT ARRAY[]::text[],
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX checklist_import_sheet_job_index_key
  ON checklist_import_sheet (job_id, sheet_index);
CREATE INDEX checklist_import_sheet_job_severity_idx
  ON checklist_import_sheet (job_id, severity);

CREATE TABLE checklist_import_row (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid      NOT NULL REFERENCES checklist_import_job(id) ON DELETE CASCADE,
  sheet_id            uuid      NOT NULL
                        REFERENCES checklist_import_sheet(id) ON DELETE CASCADE,
  source_row_number   integer   NOT NULL,
  -- The original cells, so the annotated error workbook can quote what was actually read.
  raw                 jsonb     NOT NULL,
  parsed_section      s_section NULL,
  parsed_order        integer   NULL,
  parsed_global_order integer   NULL,
  parsed_text         text      NULL,
  severity            text      NOT NULL CHECK (severity IN ('OK','WARNING','ERROR')),
  messages            text[]    NOT NULL DEFAULT ARRAY[]::text[]
);

CREATE INDEX checklist_import_row_job_severity_idx ON checklist_import_row (job_id, severity);
CREATE INDEX checklist_import_row_sheet_idx
  ON checklist_import_row (sheet_id, source_row_number);

-- =============================================================================
-- Row-level security
--
-- Defence in depth behind the ScopeGuard, as in 0001. Zones are Unit-scoped; checklists
-- are organization-wide reference data readable by any authenticated actor and writable
-- by a Super Admin alone (PART 6.3).
-- =============================================================================

ALTER TABLE zone                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_template     ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_version      ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_question     ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_import_job   ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_import_sheet ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_import_row   ENABLE ROW LEVEL SECURITY;

-- --- zone --------------------------------------------------------------------
CREATE POLICY zone_select ON zone FOR SELECT
  USING (app_is_super_admin() OR unit_id = ANY (app_actor_unit_ids()));

CREATE POLICY zone_insert ON zone FOR INSERT
  WITH CHECK (
    app_is_super_admin()
    OR (app_actor_role() = 'COORDINATOR' AND unit_id = ANY (app_actor_unit_ids()))
  );

CREATE POLICY zone_update ON zone FOR UPDATE
  USING (
    app_is_super_admin()
    OR (app_actor_role() = 'COORDINATOR' AND unit_id = ANY (app_actor_unit_ids()))
  );

-- --- checklists --------------------------------------------------------------
-- Read is deliberately broad (D2): the catalogue carries no Unit-identifying data and
-- every field client must cache it offline.
CREATE POLICY checklist_template_select ON checklist_template FOR SELECT
  USING (app_actor_id() IS NOT NULL);
CREATE POLICY checklist_template_insert ON checklist_template FOR INSERT
  WITH CHECK (app_is_super_admin());
CREATE POLICY checklist_template_update ON checklist_template FOR UPDATE
  USING (app_is_super_admin());

CREATE POLICY checklist_version_select ON checklist_version FOR SELECT
  USING (app_actor_id() IS NOT NULL);
CREATE POLICY checklist_version_insert ON checklist_version FOR INSERT
  WITH CHECK (app_is_super_admin());
CREATE POLICY checklist_version_update ON checklist_version FOR UPDATE
  USING (app_is_super_admin());

CREATE POLICY checklist_question_select ON checklist_question FOR SELECT
  USING (app_actor_id() IS NOT NULL);
CREATE POLICY checklist_question_insert ON checklist_question FOR INSERT
  WITH CHECK (app_is_super_admin());

-- --- import ------------------------------------------------------------------
-- Super Admin only, in every direction (PART 6.3, checklist_import:*).
CREATE POLICY checklist_import_job_all ON checklist_import_job FOR ALL
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());
CREATE POLICY checklist_import_sheet_all ON checklist_import_sheet FOR ALL
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());
CREATE POLICY checklist_import_row_all ON checklist_import_row FOR ALL
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());

-- =============================================================================
-- Grants
--
-- No DELETE on any checklist table: a version is superseded or archived, never removed,
-- and its questions go with it. Import rows are the exception — they belong to a job
-- that is transient working data, and they cascade with it.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE ON zone TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON checklist_template TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON checklist_version TO audit5s_app;
GRANT SELECT, INSERT ON checklist_question TO audit5s_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON checklist_import_job TO audit5s_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON checklist_import_sheet TO audit5s_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON checklist_import_row TO audit5s_app;
