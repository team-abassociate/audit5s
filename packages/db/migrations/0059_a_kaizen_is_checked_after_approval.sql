-- =============================================================================
-- 0059 — An approved Kaizen is checked at 30, 60 and 90 days (DECISIONS.md R-69)
--
-- Owner, 2026-10-29: after approval, the Unit's Coordinator walks to the Zone at 30, 60 and
-- 90 days and records whether the improvement is still in place. A check is its own
-- append-only row, so APPROVED stays terminal and 0044's transition trigger is untouched.
-- Which mark is due is the API's rule (`nextSustainCheck`); the database holds that a check
-- is made on an APPROVED Kaizen, once per mark, by the Unit's Coordinator or a Super Admin.
--
-- Also: Kaizen notifications (KAIZEN_*) reach only people holding Kaizen (R-57).
-- =============================================================================

CREATE TABLE kaizen_sustain_check (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kaizen_id           uuid NOT NULL REFERENCES kaizen (id) ON DELETE RESTRICT,
  day_mark            smallint NOT NULL CHECK (day_mark IN (30, 60, 90)),
  in_place            boolean NOT NULL,
  note                text,
  checked_by_user_id  uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  -- Snapshotted, so the Zone Leader reads who checked without reading their user row.
  checked_by_name     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kaizen_sustain_check_note_required
    CHECK (in_place OR nullif(trim(note), '') IS NOT NULL),
  CONSTRAINT kaizen_sustain_check_once UNIQUE (kaizen_id, day_mark)
);

CREATE TRIGGER kaizen_sustain_check_append_only BEFORE UPDATE OR DELETE ON kaizen_sustain_check
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

ALTER TABLE kaizen_sustain_check ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON kaizen_sustain_check TO audit5s_app;

-- Visible exactly when its Kaizen is: the subquery runs under `kaizen`'s own policy.
CREATE POLICY kaizen_sustain_check_select ON kaizen_sustain_check FOR SELECT
  USING (EXISTS (SELECT 1 FROM kaizen k WHERE k.id = kaizen_sustain_check.kaizen_id));

CREATE POLICY kaizen_sustain_check_insert ON kaizen_sustain_check FOR INSERT
  WITH CHECK (
    checked_by_user_id = app_actor_id()
    AND EXISTS (
      SELECT 1 FROM kaizen k
      WHERE k.id = kaizen_sustain_check.kaizen_id
        AND k.status = 'APPROVED'
        AND (app_is_super_admin()
             OR (app_actor_role() = 'COORDINATOR' AND k.unit_id = ANY (app_actor_unit_ids())))
    )
  );

CREATE POLICY kaizen_sustain_check_access ON kaizen_sustain_check AS RESTRICTIVE FOR ALL
  USING (app_has_kaizen_access()) WITH CHECK (app_has_kaizen_access());

COMMENT ON TABLE kaizen_sustain_check IS
  'A Coordinator''s 30/60/90-day check that an approved Kaizen is still in place (R-69). '
  'Append-only; one per Kaizen and mark.';

-- 0009's function, with one line more: a KAIZEN_* event skips anyone without Kaizen.
CREATE OR REPLACE FUNCTION app_notification_targets(
  p_event_type text,
  p_unit_id uuid,
  p_roles role[],
  p_user_ids uuid[]
) RETURNS TABLE (user_id uuid, user_role role, whatsapp_enabled boolean, sms_enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.role,
         COALESCE((SELECT p.enabled FROM notification_preference p
                   WHERE p.user_id = u.id AND p.event_type = p_event_type
                     AND p.channel = 'WHATSAPP'), true),
         COALESCE((SELECT p.enabled FROM notification_preference p
                   WHERE p.user_id = u.id AND p.event_type = p_event_type
                     AND p.channel = 'SMS'), true)
  FROM "user" u
  WHERE u.archived_at IS NULL
    AND u.status IN ('ACTIVE','INVITED')
    AND (p_event_type NOT LIKE 'KAIZEN\_%' OR u.role = 'SUPER_ADMIN' OR u.kaizen_access)
    AND (
      u.id = ANY (COALESCE(p_user_ids, ARRAY[]::uuid[]))
      OR (u.role = 'SUPER_ADMIN' AND 'SUPER_ADMIN' = ANY (COALESCE(p_roles, ARRAY[]::role[])))
      OR (
        u.role <> 'SUPER_ADMIN'
        AND u.role = ANY (COALESCE(p_roles, ARRAY[]::role[]))
        AND EXISTS (
          SELECT 1 FROM unit_membership m
          WHERE m.user_id = u.id AND m.unit_id = p_unit_id AND m.status = 'ACTIVE'
            AND now() >= m.valid_from AND (m.valid_to IS NULL OR now() < m.valid_to)
        )
      )
    );
$$;
