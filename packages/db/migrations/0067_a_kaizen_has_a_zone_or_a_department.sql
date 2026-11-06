-- =============================================================================
-- 0067 — A Kaizen is filed under a Zone, a department, or both
--
-- Owner, 2026-11-06 (DECISIONS.md R-88). A Kaizen is not bound to a Zone: anyone in the Unit
-- may make one. Additive for the release before this one: every existing row has a Zone, and
-- that release always sends one.
--
--   * `zone_id` becomes nullable, `department` is new, and a submitted Kaizen must have one.
--   * The Zone may change while the author can still edit. The number carries the Zone's
--     code, so it follows the Zone and keeps its running count; with no Zone it is `KZ-001`.
--   * A Coordinator may author a Kaizen. The service approves it on submit (no one reviews
--     it), through the same review row and transition as any other approval.
-- =============================================================================

ALTER TABLE kaizen ALTER COLUMN zone_id DROP NOT NULL;
ALTER TABLE kaizen ADD COLUMN department text;

ALTER TABLE kaizen DROP CONSTRAINT kaizen_submitted_is_complete;
ALTER TABLE kaizen ADD CONSTRAINT kaizen_submitted_is_complete CHECK (
  status = 'DRAFT' OR (
        submitted_at IS NOT NULL
    AND (zone_id IS NOT NULL OR nullif(trim(department), '') IS NOT NULL)
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
);

-- The number for a Kaizen in this Unit, under this Zone or none. SECURITY DEFINER for the same
-- reason as `kaizen_assign_number`, and it refuses a Zone that is archived or another Unit's.
CREATE FUNCTION kaizen_number(p_unit uuid, p_zone uuid, p_seq integer) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  zone_code text;
BEGIN
  IF p_zone IS NULL THEN
    RETURN 'KZ-' || lpad(p_seq::text, 3, '0');
  END IF;
  SELECT code INTO zone_code FROM zone
    WHERE id = p_zone AND unit_id = p_unit AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kaizen zone % is not an active Zone of its Unit', p_zone
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN 'KZ-' || replace(zone_code, '-', '') || '-' || lpad(p_seq::text, 3, '0');
END;
$$;

REVOKE ALL ON FUNCTION kaizen_number(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kaizen_number(uuid, uuid, integer) TO audit5s_app;

-- As 0044, except that with no Zone the Unit is the one the insert carries (the service has
-- checked it against the actor, and `kaizen_insert` below checks it again).
CREATE OR REPLACE FUNCTION kaizen_assign_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.zone_id IS NOT NULL THEN
    SELECT unit_id INTO NEW.unit_id FROM zone WHERE id = NEW.zone_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Kaizen zone % is not an active Zone', NEW.zone_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('kaizen_no:' || NEW.unit_id::text, 0));
  SELECT COALESCE(max(kaizen_seq), 0) + 1 INTO NEW.kaizen_seq
    FROM kaizen WHERE unit_id = NEW.unit_id;
  NEW.kaizen_no := kaizen_number(NEW.unit_id, NEW.zone_id, NEW.kaizen_seq);
  RETURN NEW;
END;
$$;

-- As 0044, except that the Zone may change while the sheet is editable, and the number with it.
CREATE OR REPLACE FUNCTION enforce_kaizen_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('APPROVED','REJECTED') THEN
    RAISE EXCEPTION 'Kaizen % is %: it does not change again', OLD.kaizen_no, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.unit_id IS DISTINCT FROM OLD.unit_id
     OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.author_name IS DISTINCT FROM OLD.author_name
     OR NEW.kaizen_seq IS DISTINCT FROM OLD.kaizen_seq
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Kaizen %: its Unit, author and number are fixed', OLD.kaizen_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.zone_id IS DISTINCT FROM OLD.zone_id THEN
    IF OLD.status NOT IN ('DRAFT','SENT_BACK') THEN
      RAISE EXCEPTION 'Kaizen % is %: its Zone is fixed', OLD.kaizen_no, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    NEW.kaizen_no := kaizen_number(NEW.unit_id, NEW.zone_id, NEW.kaizen_seq);
  ELSIF NEW.kaizen_no IS DISTINCT FROM OLD.kaizen_no THEN
    RAISE EXCEPTION 'Kaizen %: its number is fixed', OLD.kaizen_no
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

DROP POLICY kaizen_insert ON kaizen;
CREATE POLICY kaizen_insert ON kaizen FOR INSERT
  WITH CHECK (
    author_user_id = app_actor_id()
    AND (
      app_is_super_admin()
      OR (app_actor_role() IN ('ZONE_LEADER','COORDINATOR') AND unit_id = ANY (app_actor_unit_ids()))
    )
  );

COMMENT ON COLUMN kaizen.department IS
  'The department the author typed (R-88). A Kaizen has this, a Zone, or both; with no text '
  'here, reports fall back on its Zone''s department_hint.';
