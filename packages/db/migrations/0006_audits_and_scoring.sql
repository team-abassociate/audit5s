-- =============================================================================
-- 0006_audits_and_scoring
--
-- Phase 3 schema (ARCHITECTURE.md PART 14): the audit engine.
--
-- Tables: audit_assignment, audit, audit_zone, audit_zone_section_score,
--         question_response.
--
-- Four invariants are database guarantees here rather than service conventions,
-- because each of them protects data that cannot be reconstructed once wrong:
--
--   * A-1 — no path deletes an `audit`. There is no DELETE grant, and the trigger
--     refuses one regardless. `CANCELLED` is the strongest administrative action.
--   * A-2 — `audit`, `audit_zone` and `question_response` become append-only *after*
--     COMPLETED, not from insert. That conditional is why the generic
--     `enforce_append_only()` cannot express it and a status-aware trigger is written
--     below, in the shape of `enforce_published_version_immutable()` in 0005.
--   * QR-1 — `numeric_score IS NULL` iff `value = 'NA'`, as a CHECK. This is what makes
--     `COUNT(numeric_score)` *be* the applicable-question count, so the NA-excluding
--     denominator (D3) falls out of the SQL rather than being remembered in it.
--   * QR-2 — a response's question belongs to the audit Zone's pinned checklist version.
--     Enforced in the service (it needs a join the row does not carry) and asserted by
--     an integration test; it is what stops a mid-audit republish mixing versions.
--
-- This migration also replaces the body of `zone_has_in_progress_audit()`, the seam
-- 0005 left: `audit_zone` now exists, so the function can answer truthfully.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums (§5.1), added alongside the tables that reference them.
-- -----------------------------------------------------------------------------
CREATE TYPE audit_type AS ENUM ('EXTERNAL_5S','CROSS_5S','WALK_BY');

CREATE TYPE audit_status AS ENUM
  ('ASSIGNED','READY','IN_PROGRESS','PAUSED','COMPLETED',
   'CORRECTIVE_ACTION_OPEN','PARTIALLY_CLOSED','CLOSED','CANCELLED');

CREATE TYPE audit_zone_status AS ENUM ('DRAFT','IN_PROGRESS','COMPLETED');

CREATE TYPE assignment_status AS ENUM
  ('ASSIGNED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED');

-- `NA` is not a number, which is exactly why this is an enum and not an integer.
CREATE TYPE response_value AS ENUM ('SCORE_2','SCORE_1','SCORE_0','NA');

CREATE TYPE sync_state AS ENUM ('LOCAL_ONLY','PENDING','SYNCING','SYNCED','FAILED');

CREATE TYPE location_provider AS ENUM ('GPS','NETWORK','FUSED','UNKNOWN');

-- =============================================================================
-- Assignments (§5.5)
-- =============================================================================

CREATE TABLE audit_assignment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id             uuid NOT NULL REFERENCES unit(id) ON DELETE RESTRICT,
  auditor_user_id     uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  audit_type          audit_type        NOT NULL,
  status              assignment_status NOT NULL DEFAULT 'ASSIGNED',
  due_at              timestamptz NULL,
  instructions        text        NULL,
  -- Hints for the auditor's Zone picker, not a restriction: §5.5 is explicit that the
  -- auditor may choose others. An FK array would imply a constraint that does not exist.
  suggested_zone_ids  uuid[]      NULL,
  created_by_user_id  uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  cancelled_at        timestamptz NULL,
  cancel_reason       text        NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_assignment_auditor_idx
  ON audit_assignment (auditor_user_id, status, due_at);
CREATE INDEX audit_assignment_unit_idx ON audit_assignment (unit_id, status);
CREATE INDEX audit_assignment_due_idx ON audit_assignment (status, due_at);

CREATE TRIGGER audit_assignment_set_updated_at BEFORE UPDATE ON audit_assignment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- Audits (§5.5)
-- =============================================================================

CREATE TABLE audit (
  -- Client-generated UUIDv7. No DEFAULT: an audit that the server invented an id for
  -- could not be reconciled with the device row that authored it (D12).
  id                          uuid PRIMARY KEY,
  assignment_id               uuid NULL REFERENCES audit_assignment(id) ON DELETE RESTRICT,
  unit_id                     uuid NOT NULL REFERENCES unit(id) ON DELETE RESTRICT,
  audit_type                  audit_type   NOT NULL,
  status                      audit_status NOT NULL DEFAULT 'READY',
  auditor_user_id             uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  -- The single-writer lock (D7). One device owns an IN_PROGRESS audit; a second gets
  -- 409 DEVICE_NOT_OWNER. Nullable because a released audit has no owner.
  owning_device_id            uuid NULL REFERENCES device(id) ON DELETE RESTRICT,
  -- Audit-level default. The *binding* version is the one on each audit_zone.
  checklist_version_id        uuid NULL REFERENCES checklist_version(id) ON DELETE RESTRICT,
  -- FK to `evidence` is added by the Phase 4/5 migration that creates that table; the
  -- column ships now because the audit lifecycle writes it and §5.5 places it here.
  selfie_evidence_id          uuid NULL,
  started_at                  timestamptz NULL,
  completed_at                timestamptz NULL,
  closed_at                   timestamptz NULL,
  start_latitude              numeric(9,6) NULL,
  start_longitude             numeric(9,6) NULL,
  start_accuracy_m            numeric(8,2) NULL,
  start_location_provider     location_provider NULL,
  -- Reported by the OS. Advisory only (CH-4, §12.9); it never blocks an audit.
  start_location_is_mocked    boolean     NULL,
  -- Computed server-side. The geofence distance lands with the GPS work in Phase 4.
  start_distance_from_unit_m  numeric(10,2) NULL,
  location_suspicious         boolean     NOT NULL DEFAULT false,
  -- Score cache. Recomputable from question_response at any time, which is what makes
  -- D5 ("the server is authoritative") checkable rather than merely asserted.
  total_score                 numeric(6,3) NULL,
  applicable_questions        integer     NULL,
  na_questions                integer     NULL,
  raw_score                   integer     NULL,
  max_score                   integer     NULL,
  paused_at                   timestamptz NULL,
  pause_reason                text        NULL,
  -- Resume cursor at audit level (N7, §9.8).
  resume_audit_zone_id        uuid        NULL,
  -- Device clock. For conflict ordering only, never for a business date.
  client_created_at           timestamptz NOT NULL DEFAULT now(),
  client_updated_at           timestamptz NOT NULL DEFAULT now(),
  server_received_at          timestamptz NOT NULL DEFAULT now(),
  version                     integer     NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- There is deliberately no `cancel_reason` column. §5.5 does not give `audit` one, and
-- the reason for a cancellation belongs in the `AuditLog` entry the endpoint writes,
-- where it sits beside who did it and when — not duplicated on the row it voided.

CREATE INDEX audit_unit_status_idx ON audit (unit_id, status, completed_at DESC);
CREATE INDEX audit_auditor_idx ON audit (auditor_user_id, completed_at DESC);
CREATE INDEX audit_unit_type_idx ON audit (unit_id, audit_type, completed_at DESC);
CREATE INDEX audit_status_idx ON audit (status);
CREATE INDEX audit_suspicious_idx ON audit (location_suspicious) WHERE location_suspicious;
-- The D7 lookup: which device holds which running audit.
CREATE INDEX audit_owning_device_idx ON audit (owning_device_id) WHERE status = 'IN_PROGRESS';

CREATE TRIGGER audit_set_updated_at BEFORE UPDATE ON audit
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- Audit Zones (§5.5)
--
-- The snapshot columns are decision D6 made physical. A Coordinator must stay free to
-- rename a Zone or fix its description; a report issued last March must not change when
-- they do. Both hold because the report renders these columns and never the live `zone`.
-- =============================================================================

CREATE TABLE audit_zone (
  id                             uuid PRIMARY KEY,
  audit_id                       uuid NOT NULL REFERENCES audit(id) ON DELETE RESTRICT,
  -- The live pointer, for analytics that follow a Zone through time. RESTRICT because a
  -- Zone with history is archived, never removed.
  zone_id                        uuid NOT NULL REFERENCES zone(id) ON DELETE RESTRICT,
  sequence_no                    integer NOT NULL,
  status                         audit_zone_status NOT NULL DEFAULT 'DRAFT',

  zone_code_snapshot             text NOT NULL,
  zone_name_snapshot             text NOT NULL,
  -- This is what the report renders, which is the whole of D6 in one line.
  zone_description_snapshot      text NULL,
  zone_leader_user_id_snapshot   uuid NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  -- Survives even a user rename: the name on the report is the name at audit time.
  zone_leader_name_snapshot      text NULL,

  -- The binding version for this Zone's questions (QR-2). A republish mid-audit does not
  -- move it, which is what makes a two-year-old audit still readable against its own
  -- checklist rather than against today's.
  checklist_version_id           uuid NULL REFERENCES checklist_version(id) ON DELETE RESTRICT,
  checklist_template_name_snapshot text NULL,

  zone_remark                    text NULL,
  -- NULL when every question is NA (D4). Not 0 — 0/0 is undefined, and storing 0 would
  -- silently destroy the Zone trend.
  score_percentage               numeric(6,3) NULL,
  applicable_questions           integer NOT NULL DEFAULT 0,
  na_questions                   integer NOT NULL DEFAULT 0,
  raw_score                      integer NOT NULL DEFAULT 0,
  max_score                      integer NOT NULL DEFAULT 0,

  -- Resume cursor (N7). Resumption is entirely local (§9.8); this is the server's copy,
  -- so a replaced device resumes where the lost one stopped.
  resume_question_id             uuid NULL REFERENCES checklist_question(id) ON DELETE RESTRICT,
  started_at                     timestamptz NULL,
  completed_at                   timestamptz NULL,
  client_updated_at              timestamptz NOT NULL DEFAULT now(),
  version                        integer NOT NULL DEFAULT 1,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

-- A Zone appears at most once per audit.
CREATE UNIQUE INDEX audit_zone_audit_zone_key ON audit_zone (audit_id, zone_id);
CREATE UNIQUE INDEX audit_zone_sequence_key ON audit_zone (audit_id, sequence_no);
-- The Zone trend hot path: this Zone's audits, newest first.
CREATE INDEX audit_zone_zone_completed_idx ON audit_zone (zone_id, completed_at DESC);
CREATE INDEX audit_zone_audit_status_idx ON audit_zone (audit_id, status);

CREATE TRIGGER audit_zone_set_updated_at BEFORE UPDATE ON audit_zone
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE audit
  ADD CONSTRAINT audit_resume_audit_zone_fk
  FOREIGN KEY (resume_audit_zone_id) REFERENCES audit_zone(id) ON DELETE RESTRICT;

-- =============================================================================
-- Section scores (§5.5)
--
-- Denormalised deliberately: the radar chart and the S-trend query are the two most
-- frequent analytics reads, and recomputing them from fifty rows per Zone per request is
-- waste. Written on Zone completion, from the same pure function the device used.
-- =============================================================================

CREATE TABLE audit_zone_section_score (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_zone_id         uuid NOT NULL REFERENCES audit_zone(id) ON DELETE RESTRICT,
  section               s_section NOT NULL,
  applicable_questions  integer NOT NULL,
  na_questions          integer NOT NULL,
  raw_score             integer NOT NULL,
  max_score             integer NOT NULL,
  -- NULL for a fully-NA section (D4), and the report prints `N/A` for it.
  score_percentage      numeric(6,3) NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- D4 as a constraint: nothing applicable means no percentage, and vice versa.
  CONSTRAINT audit_zone_section_score_d4
    CHECK ((applicable_questions = 0) = (score_percentage IS NULL))
);

CREATE UNIQUE INDEX audit_zone_section_score_key
  ON audit_zone_section_score (audit_zone_id, section);

CREATE TRIGGER audit_zone_section_score_set_updated_at
  BEFORE UPDATE ON audit_zone_section_score
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- Question responses (§5.5)
-- =============================================================================

CREATE TABLE question_response (
  id                     uuid PRIMARY KEY,
  audit_zone_id          uuid NOT NULL REFERENCES audit_zone(id) ON DELETE RESTRICT,
  -- Denormalised from the parent so the audit-wide roll-up is one index scan.
  audit_id               uuid NOT NULL REFERENCES audit(id) ON DELETE RESTRICT,
  checklist_question_id  uuid NOT NULL
                           REFERENCES checklist_question(id) ON DELETE RESTRICT,
  -- Denormalised from the question: makes S-wise aggregation index-only.
  section                s_section NOT NULL,
  global_order           integer NOT NULL,
  value                  response_value NOT NULL,
  -- Invariant QR-1.
  numeric_score          smallint NULL,
  -- The optional per-question remark the zone report prints under the question.
  remark                 text NULL,
  answered_at            timestamptz NOT NULL,
  client_updated_at      timestamptz NOT NULL DEFAULT now(),
  sync_state             sync_state NOT NULL DEFAULT 'SYNCED',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- Invariant QR-1, in full. Both halves matter: NA must have no number, and every
  -- other value must have exactly the right one. No client bug can poison the maths.
  CONSTRAINT question_response_qr1 CHECK (
    (value = 'NA'      AND numeric_score IS NULL) OR
    (value = 'SCORE_0' AND numeric_score = 0)     OR
    (value = 'SCORE_1' AND numeric_score = 1)     OR
    (value = 'SCORE_2' AND numeric_score = 2)
  )
);

-- The idempotency backbone: a retried sync can only ever update the same row.
CREATE UNIQUE INDEX question_response_zone_question_key
  ON question_response (audit_zone_id, checklist_question_id);
CREATE INDEX question_response_audit_idx ON question_response (audit_id);
CREATE INDEX question_response_zone_order_idx ON question_response (audit_zone_id, global_order);
-- Recurrence analytics: which question fails, and how often.
CREATE INDEX question_response_question_value_idx
  ON question_response (checklist_question_id, value);

CREATE TRIGGER question_response_set_updated_at BEFORE UPDATE ON question_response
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- Invariant A-2 — conditional append-only
--
-- `enforce_append_only()` cannot express this rule. That function is unconditional: a
-- table wearing it is frozen from INSERT. A-2 freezes these three tables only *after*
-- the audit reaches COMPLETED, because until then the auditor is still answering
-- questions. So this is a status-aware trigger, in the shape of 0005's
-- `enforce_published_version_immutable()`: a named carve-out beside the rule it bends.
--
-- The carve-out is the Super Admin override path of §8.6, and it is a *named* one: the
-- service sets `app.post_completion_override = 'on'` inside the transaction that writes
-- the `AuditLog` entry, and only there. Any other UPDATE on a completed audit raises. A
-- trigger with no such path would push the override into a DBA's psql session, where it
-- would leave no audit trail at all — which is the outcome A-2 exists to prevent.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_post_completion_override() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.post_completion_override', true), '') = 'on'
     AND app_is_super_admin();
$$;

CREATE OR REPLACE FUNCTION enforce_completed_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Statuses at or past COMPLETED. The corrective-action statuses are included because
  -- they are all downstream of completion: the audited facts are settled by then.
  frozen_statuses audit_status[] := ARRAY['COMPLETED','CORRECTIVE_ACTION_OPEN',
                                          'PARTIALLY_CLOSED','CLOSED']::audit_status[];
  -- The audit's own lifecycle continues past COMPLETED — corrective actions move it
  -- through three more statuses — so those columns stay writable on `audit` itself.
  -- They are the status and its timestamps, and nothing that was audited.
  lifecycle_columns text[] := ARRAY['status','closed_at','updated_at','version'];
  owning_audit   uuid;
  audit_state    audit_status;
  changed_column text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A-1/D8, with no carve-out at all: not for a Super Admin, not under an override.
    RAISE EXCEPTION
      'Table % is never deleted from: an audit is cancelled, not removed (A-1, D8)',
      TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_TABLE_NAME = 'audit' THEN
    -- The row being updated *is* the audit, and the move out of COMPLETED is what is
    -- being judged, so read the pre-image rather than the table.
    owning_audit := OLD.id;
    audit_state  := OLD.status;
  ELSE
    owning_audit := OLD.audit_id;
    SELECT a.status INTO audit_state FROM audit a WHERE a.id = owning_audit;
  END IF;

  IF NOT (audit_state = ANY (frozen_statuses)) THEN
    RETURN NEW;
  END IF;

  IF app_post_completion_override() THEN
    RETURN NEW;
  END IF;

  FOR changed_column IN
    SELECT key
    FROM jsonb_each(to_jsonb(OLD)) AS o(key, value)
    WHERE o.value IS DISTINCT FROM (to_jsonb(NEW) -> o.key)
  LOOP
    IF TG_TABLE_NAME = 'audit' AND changed_column = ANY (lifecycle_columns) THEN
      CONTINUE;
    END IF;

    RAISE EXCEPTION
      'Audit % is %: %.% may not be updated after completion. The post-completion '
      'override endpoint is the only path, and it writes an audit-log entry with '
      'before and after (A-2)',
      owning_audit, audit_state, TG_TABLE_NAME, changed_column
      USING ERRCODE = 'restrict_violation';
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_append_only_after_completion
  BEFORE UPDATE OR DELETE ON audit
  FOR EACH ROW EXECUTE FUNCTION enforce_completed_audit_append_only();

CREATE TRIGGER audit_zone_append_only_after_completion
  BEFORE UPDATE OR DELETE ON audit_zone
  FOR EACH ROW EXECUTE FUNCTION enforce_completed_audit_append_only();

CREATE TRIGGER question_response_append_only_after_completion
  BEFORE UPDATE OR DELETE ON question_response
  FOR EACH ROW EXECUTE FUNCTION enforce_completed_audit_append_only();

-- Section scores are derived, not authored, so they are not A-2 material — but they are
-- still never deleted, because a report re-rendered from a snapshot must find them.
CREATE OR REPLACE FUNCTION enforce_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is never deleted from (D8)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_zone_section_score_no_delete
  BEFORE DELETE ON audit_zone_section_score
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

-- =============================================================================
-- The Phase 2 seam, closed
--
-- 0005 defined this function returning false, because `audit_zone` did not exist and
-- nothing could be in progress. It exists now, so the function answers truthfully and
-- the 409 in §8.4 stops being a branch nobody executes.
--
-- SECURITY DEFINER: archiving is a Coordinator's action, and RLS on `audit` would
-- otherwise hide another auditor's running audit from them — turning "this Zone is busy"
-- into "this Zone is free", which is the one wrong answer this function must not give.
-- =============================================================================
CREATE OR REPLACE FUNCTION zone_has_in_progress_audit(target_zone_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM audit_zone az
    JOIN audit a ON a.id = az.audit_id
    WHERE az.zone_id = target_zone_id
      AND az.status <> 'COMPLETED'
      AND a.status IN ('ASSIGNED','READY','IN_PROGRESS','PAUSED')
  );
$$;

-- =============================================================================
-- Row-level security
--
-- Defence in depth behind the ScopeGuard, mirroring PART 6.3's audit rows: a Super Admin
-- sees everything, a Consultant their own audits, a Coordinator and a Zone Leader their
-- Unit's. Writes are narrower still — only the auditor writes their own audit.
-- =============================================================================

ALTER TABLE audit_assignment         ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_zone               ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_zone_section_score ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_response        ENABLE ROW LEVEL SECURITY;

-- --- audit_assignment --------------------------------------------------------
CREATE POLICY audit_assignment_select ON audit_assignment FOR SELECT
  USING (
    app_is_super_admin()
    OR auditor_user_id = app_actor_id()
    OR unit_id = ANY (app_actor_unit_ids())
  );
CREATE POLICY audit_assignment_insert ON audit_assignment FOR INSERT
  WITH CHECK (app_is_super_admin());
CREATE POLICY audit_assignment_update ON audit_assignment FOR UPDATE
  USING (app_is_super_admin() OR auditor_user_id = app_actor_id());

-- --- audit -------------------------------------------------------------------
CREATE POLICY audit_select ON audit FOR SELECT
  USING (
    app_is_super_admin()
    OR auditor_user_id = app_actor_id()
    OR unit_id = ANY (app_actor_unit_ids())
  );
-- Only the auditor creates their own audit, and only in a Unit they belong to. A
-- Super Admin has no INSERT policy here at all: PART 6 grants nobody `audit:create`
-- but the two field roles, and the absence is the enforcement.
CREATE POLICY audit_insert ON audit FOR INSERT
  WITH CHECK (auditor_user_id = app_actor_id() AND unit_id = ANY (app_actor_unit_ids()));
CREATE POLICY audit_update ON audit FOR UPDATE
  USING (app_is_super_admin() OR auditor_user_id = app_actor_id());

-- --- audit_zone --------------------------------------------------------------
CREATE POLICY audit_zone_select ON audit_zone FOR SELECT
  USING (
    app_is_super_admin()
    OR EXISTS (
      SELECT 1 FROM audit a
      WHERE a.id = audit_zone.audit_id
        AND (a.auditor_user_id = app_actor_id() OR a.unit_id = ANY (app_actor_unit_ids()))
    )
  );
CREATE POLICY audit_zone_insert ON audit_zone FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM audit a
            WHERE a.id = audit_zone.audit_id AND a.auditor_user_id = app_actor_id())
  );
CREATE POLICY audit_zone_update ON audit_zone FOR UPDATE
  USING (
    app_is_super_admin()
    OR EXISTS (SELECT 1 FROM audit a
               WHERE a.id = audit_zone.audit_id AND a.auditor_user_id = app_actor_id())
  );

-- --- audit_zone_section_score ------------------------------------------------
CREATE POLICY audit_zone_section_score_select ON audit_zone_section_score FOR SELECT
  USING (
    app_is_super_admin()
    OR EXISTS (
      SELECT 1 FROM audit_zone az JOIN audit a ON a.id = az.audit_id
      WHERE az.id = audit_zone_section_score.audit_zone_id
        AND (a.auditor_user_id = app_actor_id() OR a.unit_id = ANY (app_actor_unit_ids()))
    )
  );
CREATE POLICY audit_zone_section_score_write ON audit_zone_section_score FOR ALL
  USING (
    app_is_super_admin()
    OR EXISTS (
      SELECT 1 FROM audit_zone az JOIN audit a ON a.id = az.audit_id
      WHERE az.id = audit_zone_section_score.audit_zone_id
        AND a.auditor_user_id = app_actor_id()
    )
  )
  WITH CHECK (
    app_is_super_admin()
    OR EXISTS (
      SELECT 1 FROM audit_zone az JOIN audit a ON a.id = az.audit_id
      WHERE az.id = audit_zone_section_score.audit_zone_id
        AND a.auditor_user_id = app_actor_id()
    )
  );

-- --- question_response -------------------------------------------------------
CREATE POLICY question_response_select ON question_response FOR SELECT
  USING (
    app_is_super_admin()
    OR EXISTS (
      SELECT 1 FROM audit a
      WHERE a.id = question_response.audit_id
        AND (a.auditor_user_id = app_actor_id() OR a.unit_id = ANY (app_actor_unit_ids()))
    )
  );
CREATE POLICY question_response_insert ON question_response FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM audit a
            WHERE a.id = question_response.audit_id AND a.auditor_user_id = app_actor_id())
  );
CREATE POLICY question_response_update ON question_response FOR UPDATE
  USING (
    app_is_super_admin()
    OR EXISTS (SELECT 1 FROM audit a
               WHERE a.id = question_response.audit_id AND a.auditor_user_id = app_actor_id())
  );

-- =============================================================================
-- Grants
--
-- **No DELETE anywhere in this migration**, for any role including the application's.
-- D8 names `Audit`, `AuditZone` and `QuestionResponse` explicitly, and A-1 says no API
-- path deletes an audit. The trigger refuses one; the missing grant means the statement
-- never reaches the trigger. Both, deliberately.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE ON audit_assignment TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON audit TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON audit_zone TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON audit_zone_section_score TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON question_response TO audit5s_app;
