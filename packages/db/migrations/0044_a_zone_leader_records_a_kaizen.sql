-- =============================================================================
-- 0044 — A Zone Leader records a Kaizen; their Coordinator reviews it
--
-- Leanstack's second module (DECISIONS.md R-48, plans/kaizen-module.md §4.1). Additive
-- only: three new tables, their enums, policies and triggers. No existing table, column,
-- trigger or enum value is touched, so the release before this one runs unchanged on it.
--
--   * `kaizen` — one improvement, on the client's Kaizen Sheet. Created offline with a
--     device-minted id; numbered by the database on first receipt.
--   * `kaizen_review` — the Coordinator's decisions. Append-only.
--   * `kaizen_photo` — the sheet's before and after photographs. Kaizen's own list, by the
--     owner's decision: `evidence` belongs to 5S audits (its `audit_id` is NOT NULL and
--     its triggers read the audit), and a Kaizen is not an audit. The upload pipeline —
--     presigned PUT, magic bytes, EXIF strip, SHA-256, content-addressed key — is the same
--     code; only the row it confirms is different.
--
-- Nothing is hard-deleted (D8). A Kaizen ends APPROVED or REJECTED, never removed; a
-- replaced photo is soft-deleted.
-- =============================================================================

CREATE TYPE kaizen_status AS ENUM ('DRAFT','SUBMITTED','APPROVED','SENT_BACK','REJECTED');
CREATE TYPE kaizen_review_decision AS ENUM ('APPROVED','SENT_BACK','REJECTED');
CREATE TYPE kaizen_waste AS ENUM
  ('DEFECTS','OVERPRODUCTION','WAITING_TIME','NON_UTILIZED_TALENT',
   'TRANSPORTATION','INVENTORY','MOTION','EXTRA_PROCESSING');
CREATE TYPE kaizen_parameter AS ENUM
  ('PRODUCTIVITY','QUALITY','COST','DELIVERY','SAFETY','MORALE');
CREATE TYPE kaizen_photo_kind AS ENUM ('BEFORE','AFTER');

-- =============================================================================
-- kaizen
-- =============================================================================
CREATE TABLE kaizen (
  -- Minted by the device (UUIDv7), so a create replayed through the outbox is the same row.
  id                     uuid PRIMARY KEY,
  -- Both set from the Zone by `kaizen_assign_number()`; a client cannot choose the Unit.
  unit_id                uuid NOT NULL REFERENCES unit (id) ON DELETE RESTRICT,
  zone_id                uuid NOT NULL REFERENCES zone (id) ON DELETE RESTRICT,
  author_user_id         uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  -- Snapshotted, so a Coordinator or Consultant reading the card never joins `user`
  -- (R-14(e): a display name is not a reason to join a table the reader cannot see).
  author_name            text NOT NULL,
  -- `KZ-{zone code without dash}-{count, 3+ digits}`, the count running per Unit.
  kaizen_seq             integer NOT NULL,
  kaizen_no              text NOT NULL,

  -- The sheet. Nullable while DRAFT; `kaizen_submitted_is_complete` below requires the
  -- prototype's mandatory steps on everything else.
  machine                text,
  line_area              text,
  implemented_on         date,
  team_members           text,
  theme                  text,
  target                 text,
  problem_5w1h           text,
  root_cause_4m          text,
  analysis_7qc           text,
  countermeasure         text,
  wastes                 kaizen_waste[] NOT NULL DEFAULT '{}',
  parameters             kaizen_parameter[] NOT NULL DEFAULT '{}',
  horizontal_deployment  boolean,
  benefits               text,
  annual_saving          numeric(14,2) CHECK (annual_saving >= 0),
  idea_by                text,
  implemented_by         text,

  status                 kaizen_status NOT NULL DEFAULT 'DRAFT',
  -- First submission; a resubmission after SENT_BACK does not move it. Every dashboard
  -- period counts a Kaizen by this.
  submitted_at           timestamptz,
  -- The device-minted id of the submission that put it in SUBMITTED, so a replay of that
  -- submission is recognised as one rather than applied again.
  last_submission_id     uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kaizen_submitted_is_complete CHECK (
    status = 'DRAFT' OR (
          submitted_at IS NOT NULL
      AND nullif(trim(machine), '') IS NOT NULL
      AND nullif(trim(line_area), '') IS NOT NULL
      AND implemented_on IS NOT NULL
      AND nullif(trim(team_members), '') IS NOT NULL
      AND nullif(trim(theme), '') IS NOT NULL
      AND nullif(trim(problem_5w1h), '') IS NOT NULL
      AND nullif(trim(countermeasure), '') IS NOT NULL
      AND horizontal_deployment IS NOT NULL
      AND nullif(trim(benefits), '') IS NOT NULL
      AND nullif(trim(root_cause_4m), '') IS NOT NULL
      AND nullif(trim(idea_by), '') IS NOT NULL
      AND nullif(trim(implemented_by), '') IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX kaizen_unit_seq_key ON kaizen (unit_id, kaizen_seq);
CREATE UNIQUE INDEX kaizen_unit_no_key ON kaizen (unit_id, kaizen_no);
-- The Coordinator's queue and every dashboard read: one Unit, by status, by period.
CREATE INDEX kaizen_unit_status_submitted_idx ON kaizen (unit_id, status, submitted_at);
CREATE INDEX kaizen_author_idx ON kaizen (author_user_id, created_at DESC);
CREATE INDEX kaizen_zone_idx ON kaizen (zone_id);

CREATE TRIGGER kaizen_set_updated_at BEFORE UPDATE ON kaizen
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kaizen_no_delete BEFORE DELETE ON kaizen
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

-- Numbering, on the database's side of the sync boundary. SECURITY DEFINER because the
-- count must see every Kaizen of the Unit, and a Zone Leader's own policy shows them only
-- theirs. The advisory lock serialises two inserts for one Unit, so the next number is
-- never handed out twice; the unique index is the backstop.
CREATE OR REPLACE FUNCTION kaizen_assign_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  z record;
BEGIN
  SELECT unit_id, code, archived_at INTO z FROM zone WHERE id = NEW.zone_id;
  IF NOT FOUND OR z.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Kaizen zone % is not an active Zone', NEW.zone_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.unit_id := z.unit_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('kaizen_no:' || z.unit_id::text, 0));
  SELECT COALESCE(max(kaizen_seq), 0) + 1 INTO NEW.kaizen_seq
    FROM kaizen WHERE unit_id = z.unit_id;
  NEW.kaizen_no := 'KZ-' || replace(z.code, '-', '') || '-' || lpad(NEW.kaizen_seq::text, 3, '0');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION kaizen_assign_number() FROM PUBLIC;

CREATE TRIGGER kaizen_assign_number BEFORE INSERT ON kaizen
  FOR EACH ROW EXECUTE FUNCTION kaizen_assign_number();

-- The state machine's database half (the rule itself is `packages/domain`'s):
--
--   DRAFT → SUBMITTED, SENT_BACK → SUBMITTED              the author
--   SUBMITTED → APPROVED | SENT_BACK | REJECTED          a reviewer, with a review row
--
-- APPROVED and REJECTED are terminal: nothing about the row changes again. The sheet is
-- editable only in DRAFT and SENT_BACK, so a Coordinator approves exactly what was
-- submitted. A review decision must be written in the same transaction as the move it
-- makes — `now()` is the transaction's start, so a review row stamped with it is this
-- transaction's.
CREATE OR REPLACE FUNCTION enforce_kaizen_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('APPROVED','REJECTED') THEN
    RAISE EXCEPTION 'Kaizen % is %: it does not change again', OLD.kaizen_no, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.unit_id IS DISTINCT FROM OLD.unit_id
     OR NEW.zone_id IS DISTINCT FROM OLD.zone_id
     OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.author_name IS DISTINCT FROM OLD.author_name
     OR NEW.kaizen_seq IS DISTINCT FROM OLD.kaizen_seq
     OR NEW.kaizen_no IS DISTINCT FROM OLD.kaizen_no
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Kaizen %: its Unit, Zone, author and number are fixed', OLD.kaizen_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'SUBMITTED'
     AND (to_jsonb(NEW) - ARRAY['status','updated_at']) IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status','updated_at']) THEN
    RAISE EXCEPTION 'Kaizen % is awaiting review: the sheet cannot be edited', OLD.kaizen_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status IN ('DRAFT','SENT_BACK') AND NEW.status = 'SUBMITTED')
      OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('APPROVED','SENT_BACK','REJECTED'))
    ) THEN
      RAISE EXCEPTION 'Kaizen %: % → % is not a move', OLD.kaizen_no, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.status = 'SUBMITTED' AND NOT EXISTS (
      SELECT 1 FROM kaizen_review r
      WHERE r.kaizen_id = NEW.id
        AND r.decision::text = NEW.status::text
        AND r.created_at = now()
    ) THEN
      RAISE EXCEPTION 'Kaizen %: % needs its review written first', OLD.kaizen_no, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- kaizen_review — append-only
-- =============================================================================
CREATE TABLE kaizen_review (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kaizen_id         uuid NOT NULL REFERENCES kaizen (id) ON DELETE RESTRICT,
  reviewer_user_id  uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  -- Snapshotted, so the Zone Leader reads who decided without reading their user row.
  reviewer_name     text NOT NULL,
  reviewer_role     role NOT NULL,
  decision          kaizen_review_decision NOT NULL,
  comment           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kaizen_review_reason_required
    CHECK (decision = 'APPROVED' OR nullif(trim(comment), '') IS NOT NULL)
);

CREATE INDEX kaizen_review_kaizen_idx ON kaizen_review (kaizen_id, created_at);
-- "Approved that month, by review date" (§4.7 C).
CREATE INDEX kaizen_review_decision_created_idx ON kaizen_review (decision, created_at);

CREATE TRIGGER kaizen_review_append_only BEFORE UPDATE OR DELETE ON kaizen_review
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

-- Declared after `kaizen_review` exists: plpgsql resolves the table at first call, but
-- the order reads true.
CREATE TRIGGER kaizen_transition BEFORE UPDATE ON kaizen
  FOR EACH ROW EXECUTE FUNCTION enforce_kaizen_transition();

-- =============================================================================
-- kaizen_photo
-- =============================================================================
CREATE TABLE kaizen_photo (
  -- Minted by the device, so a retried upload intent returns the same key (§8.7).
  id                      uuid PRIMARY KEY,
  kaizen_id               uuid NOT NULL REFERENCES kaizen (id) ON DELETE RESTRICT,
  kind                    kaizen_photo_kind NOT NULL,
  -- `unit/{unitId}/kaizen/{kaizenId}/{sha256}.jpg`: stable and content-addressed.
  object_key              text NOT NULL,
  content_type            text NOT NULL,
  byte_size               bigint NOT NULL CHECK (byte_size > 0),
  width                   integer,
  height                  integer,
  -- What the device asserted at capture and `commit` verified. Never overwritten.
  checksum_sha256         text NOT NULL,
  -- Set only if the server had to sanitise the stored object (R-12(c)).
  stored_checksum_sha256  text,
  captured_at             timestamptz NOT NULL,
  uploaded_at             timestamptz,
  -- False ⇒ chosen from the gallery, which Kaizen allows (R-48).
  is_live_capture         boolean NOT NULL DEFAULT false,
  created_by_user_id      uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  deleted_at              timestamptz,
  deleted_by_user_id      uuid REFERENCES "user" (id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX kaizen_photo_object_key_key ON kaizen_photo (object_key);
-- One live photo per box on the sheet. Replacing is soft-delete, then a new row.
CREATE UNIQUE INDEX kaizen_photo_one_live_per_kind
  ON kaizen_photo (kaizen_id, kind) WHERE deleted_at IS NULL;

CREATE TRIGGER kaizen_photo_set_updated_at BEFORE UPDATE ON kaizen_photo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kaizen_photo_no_delete BEFORE DELETE ON kaizen_photo
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

-- A photo is added or removed only while its Kaizen is editable, so what a Coordinator
-- approved is what the sheet prints. `commit` (uploaded_at, size, checksum) may land any
-- time: the bytes often arrive after the submission that cites them.
CREATE OR REPLACE FUNCTION enforce_kaizen_photo_editable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  kaizen_status_now kaizen_status;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['width','height','stored_checksum_sha256','uploaded_at',
                              'deleted_at','deleted_by_user_id','updated_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['width','height','stored_checksum_sha256','uploaded_at',
                              'deleted_at','deleted_by_user_id','updated_at']) THEN
      RAISE EXCEPTION 'Kaizen photo %: only its upload and removal may change', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'Kaizen photo % is already removed', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT status INTO kaizen_status_now FROM kaizen WHERE id = NEW.kaizen_id;
  IF kaizen_status_now NOT IN ('DRAFT','SENT_BACK') THEN
    RAISE EXCEPTION 'Kaizen photos change only while the Kaizen is a draft or sent back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_kaizen_photo_editable() FROM PUBLIC;

CREATE TRIGGER kaizen_photo_editable BEFORE INSERT OR UPDATE ON kaizen_photo
  FOR EACH ROW EXECUTE FUNCTION enforce_kaizen_photo_editable();

-- =============================================================================
-- Row-level security — defence in depth behind the ScopeGuard (STACK.md §5)
--
--   Zone Leader   their own Kaizens only (owner's ruling, R-48)
--   Coordinator   every Kaizen of their Unit; reviews them
--   Consultant    every Kaizen of the Units they may reach; reads only
--   Super Admin   everything (R-18)
-- =============================================================================
ALTER TABLE kaizen ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE kaizen_photo ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON kaizen TO audit5s_app;
GRANT SELECT, INSERT ON kaizen_review TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON kaizen_photo TO audit5s_app;

CREATE POLICY kaizen_select ON kaizen FOR SELECT
  USING (
    app_is_super_admin()
    OR author_user_id = app_actor_id()
    OR (app_actor_role() IN ('COORDINATOR','CONSULTANT') AND unit_id = ANY (app_actor_unit_ids()))
  );

-- `unit_id` is the trigger's, from the Zone, by the time this is checked.
CREATE POLICY kaizen_insert ON kaizen FOR INSERT
  WITH CHECK (
    author_user_id = app_actor_id()
    AND (
      app_is_super_admin()
      OR (app_actor_role() = 'ZONE_LEADER' AND unit_id = ANY (app_actor_unit_ids()))
    )
  );

-- The author edits and submits while it is theirs to edit; the Coordinator decides while
-- it waits. The transition trigger says which moves each may make.
CREATE POLICY kaizen_update ON kaizen FOR UPDATE
  USING (
    app_is_super_admin()
    OR (author_user_id = app_actor_id() AND status IN ('DRAFT','SENT_BACK'))
    OR (app_actor_role() = 'COORDINATOR' AND status = 'SUBMITTED'
        AND unit_id = ANY (app_actor_unit_ids()))
  )
  WITH CHECK (
    app_is_super_admin()
    OR author_user_id = app_actor_id()
    OR (app_actor_role() = 'COORDINATOR' AND unit_id = ANY (app_actor_unit_ids()))
  );

-- Visible exactly when its Kaizen is: the subquery runs under `kaizen`'s own policy.
CREATE POLICY kaizen_review_select ON kaizen_review FOR SELECT
  USING (EXISTS (SELECT 1 FROM kaizen k WHERE k.id = kaizen_review.kaizen_id));

CREATE POLICY kaizen_review_insert ON kaizen_review FOR INSERT
  WITH CHECK (
    reviewer_user_id = app_actor_id()
    AND (
      app_is_super_admin()
      OR (app_actor_role() = 'COORDINATOR' AND EXISTS (
            SELECT 1 FROM kaizen k
            WHERE k.id = kaizen_review.kaizen_id AND k.unit_id = ANY (app_actor_unit_ids())))
    )
  );

CREATE POLICY kaizen_photo_select ON kaizen_photo FOR SELECT
  USING (EXISTS (SELECT 1 FROM kaizen k WHERE k.id = kaizen_photo.kaizen_id));

CREATE POLICY kaizen_photo_insert ON kaizen_photo FOR INSERT
  WITH CHECK (
    created_by_user_id = app_actor_id()
    AND EXISTS (SELECT 1 FROM kaizen k
                WHERE k.id = kaizen_photo.kaizen_id
                  AND (k.author_user_id = app_actor_id() OR app_is_super_admin()))
  );

CREATE POLICY kaizen_photo_update ON kaizen_photo FOR UPDATE
  USING (created_by_user_id = app_actor_id() OR app_is_super_admin());

COMMENT ON TABLE kaizen IS
  'A Kaizen (R-48). Never deleted; APPROVED and REJECTED are terminal. kaizen_no is the '
  'database''s, from the Zone code and a running count per Unit.';
COMMENT ON TABLE kaizen_review IS
  'A Coordinator''s (or Super Admin''s) decision on a submitted Kaizen. Append-only.';
COMMENT ON TABLE kaizen_photo IS
  'A Kaizen''s before/after photograph. Kaizen''s own list, through the same presigned '
  'upload pipeline as evidence. Soft-deleted only while the Kaizen is editable.';
