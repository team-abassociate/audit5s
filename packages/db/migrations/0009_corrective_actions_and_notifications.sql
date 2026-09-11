-- =============================================================================
-- 0009_corrective_actions_and_notifications
--
-- Phase 6 schema (ARCHITECTURE.md PART 14): corrective actions and notifications.
--
-- Tables: corrective_action, corrective_action_submission, notification,
-- notification_delivery, notification_preference.
--
-- Database guarantees in this file, each the reason something cannot go wrong rather than
-- a convention that it does not:
--
--   * One action per nonconformity photograph — `UNIQUE(evidence_id)`. Materialisation is
--     an `INSERT ... ON CONFLICT DO NOTHING`, so completing an audit twice cannot raise
--     ten actions for five findings.
--   * CA-1 — a submission is never updated except to record its review, once, and never
--     deleted. A resubmission is a new row with `attempt_no + 1`, and the pair is unique.
--     This is what makes "3 of 5 submitted, 2 next week" safe by construction (§7.3).
--   * CA-2 — Option A needs a description and an after-photo, Option B an explanation, as
--     CHECKs; the after-photo being a live capture *for this action and this attempt* is a
--     trigger, because it reads another table.
--   * Nothing here is deleted: no DELETE grant, and a trigger behind the missing grant.
--
-- And one change to an existing rule, recorded as DECISIONS.md R-13: a corrective
-- after-photo is captured after its audit completed — that is what "after" means — so the
-- R-10 trigger, which freezes a completed audit's evidence, would refuse its `commit`. The
-- rule now reaches an after-photo once an attempt cites it, not before.
-- =============================================================================

CREATE TYPE corrective_action_status AS ENUM
  ('OPEN','ACTION_SUBMITTED','NOT_POSSIBLE','VERIFIED','REOPENED');
CREATE TYPE corrective_option AS ENUM ('COMPLETED','NOT_POSSIBLE');
CREATE TYPE notification_channel AS ENUM ('IN_APP','WHATSAPP','SMS','EMAIL');
CREATE TYPE notification_status AS ENUM ('PENDING','SENT','DELIVERED','FAILED','SKIPPED');

-- =============================================================================
-- corrective_action (§5.7)
-- =============================================================================

CREATE TABLE corrective_action (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The nonconformity photograph. UNIQUE below: exactly one action per evidence item.
  evidence_id                   uuid NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  audit_id                      uuid NOT NULL REFERENCES audit(id) ON DELETE RESTRICT,
  audit_zone_id                 uuid NOT NULL REFERENCES audit_zone(id) ON DELETE RESTRICT,
  -- Denormalised for the scope predicates (`own_unit`, `assigned_actions`) and analytics.
  unit_id                       uuid NOT NULL REFERENCES unit(id) ON DELETE RESTRICT,
  zone_id                       uuid NOT NULL REFERENCES zone(id) ON DELETE RESTRICT,
  -- Null for a walk-by item: there is no questionnaire (§2.7).
  checklist_question_id         uuid NULL REFERENCES checklist_question(id) ON DELETE RESTRICT,
  status                        corrective_action_status NOT NULL DEFAULT 'OPEN',
  -- Routed from `zone.zone_leader_id` at materialisation. A pointer, not a grant: R-3b's
  -- `assigned_actions` admits every Zone Leader of the Unit so an action cannot stall.
  assigned_zone_leader_user_id  uuid NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  due_at                        timestamptz NULL,
  opened_at                     timestamptz NOT NULL DEFAULT now(),
  last_submitted_at             timestamptz NULL,
  -- VERIFIED, which is also how an accepted NOT_POSSIBLE ends (§7.3).
  resolved_at                   timestamptz NULL,
  verified_by_user_id           uuid NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  reopen_count                  integer NOT NULL DEFAULT 0,
  -- Optimistic lock: a Zone Leader and a Super Admin acting at once get one winner (§15.8).
  version                       integer NOT NULL DEFAULT 1,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT corrective_action_resolved_iff_verified CHECK (
    (status = 'VERIFIED') = (resolved_at IS NOT NULL)
  ),
  CONSTRAINT corrective_action_reopen_count CHECK (reopen_count >= 0)
);

CREATE UNIQUE INDEX corrective_action_evidence_key ON corrective_action (evidence_id);
CREATE INDEX corrective_action_unit_status_idx ON corrective_action (unit_id, status);
CREATE INDEX corrective_action_assignee_status_idx
  ON corrective_action (assigned_zone_leader_user_id, status);
CREATE INDEX corrective_action_audit_status_idx ON corrective_action (audit_id, status);
CREATE INDEX corrective_action_zone_opened_idx ON corrective_action (zone_id, opened_at DESC);
CREATE INDEX corrective_action_overdue_idx
  ON corrective_action (status, due_at) WHERE status IN ('OPEN','REOPENED');

CREATE TRIGGER corrective_action_set_updated_at BEFORE UPDATE ON corrective_action
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- "Actions are never deleted" (§7.3). There is no DELETE route and no DELETE grant.
CREATE TRIGGER corrective_action_no_delete BEFORE DELETE ON corrective_action
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

-- =============================================================================
-- corrective_action_submission (§5.7) — append-only (CA-1)
-- =============================================================================

CREATE TABLE corrective_action_submission (
  -- Client-minted on a device (the outbox id, and the after-photo's key segment, §5.6);
  -- server-minted otherwise. A replayed item therefore finds its own row.
  id                    uuid PRIMARY KEY,
  corrective_action_id  uuid NOT NULL REFERENCES corrective_action(id) ON DELETE RESTRICT,
  attempt_no            integer NOT NULL,
  option                corrective_option NOT NULL,
  submitted_by_user_id  uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  -- Typed by the Zone Leader for Option A and snapshotted; the account name otherwise.
  submitted_by_name     text NOT NULL,
  description           text NULL,
  explanation           text NULL,
  after_evidence_id     uuid NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  submitted_via         text NOT NULL,
  -- The signed link used, when there was one. The FK lands with `report_access_token`
  -- in Phase 7, for the reason every seam in this schema waited: no referent yet.
  access_token_id       uuid NULL,
  ip_address            text NULL,
  user_agent            text NULL,
  review_outcome        text NULL,
  reviewed_by_user_id   uuid NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  reviewed_at           timestamptz NULL,
  review_comment        text NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT corrective_action_submission_attempt CHECK (attempt_no >= 1),
  CONSTRAINT corrective_action_submission_via CHECK (
    submitted_via IN ('MOBILE','WEB_TOKEN','WEB_SESSION')
  ),
  -- CA-2, both halves.
  CONSTRAINT corrective_action_submission_ca2_completed CHECK (
    option <> 'COMPLETED'
    OR (after_evidence_id IS NOT NULL AND btrim(COALESCE(description, '')) <> '')
  ),
  CONSTRAINT corrective_action_submission_ca2_not_possible CHECK (
    option <> 'NOT_POSSIBLE' OR btrim(COALESCE(explanation, '')) <> ''
  ),
  CONSTRAINT corrective_action_submission_review_outcome CHECK (
    review_outcome IS NULL OR review_outcome IN ('VERIFIED','REOPENED')
  ),
  -- A review without a reviewer, or a time, is a half-recorded decision.
  CONSTRAINT corrective_action_submission_review_together CHECK (
    (review_outcome IS NULL) = (reviewed_at IS NULL)
    AND (reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)
  )
);

CREATE UNIQUE INDEX corrective_action_submission_attempt_key
  ON corrective_action_submission (corrective_action_id, attempt_no);
CREATE INDEX corrective_action_submission_history_idx
  ON corrective_action_submission (corrective_action_id, created_at DESC);
-- One photograph answers one attempt. A resubmission takes a new after-photo.
CREATE UNIQUE INDEX corrective_action_submission_after_evidence_key
  ON corrective_action_submission (after_evidence_id) WHERE after_evidence_id IS NOT NULL;

-- CA-1: the four review columns are the only ones that may change...
CREATE TRIGGER corrective_action_submission_append_only
  BEFORE UPDATE OR DELETE ON corrective_action_submission
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only(
    'review_outcome', 'reviewed_by_user_id', 'reviewed_at', 'review_comment'
  );

-- ...and only once. A reviewed attempt is history; a later decision is recorded on the
-- next attempt, never by rewriting this one.
CREATE OR REPLACE FUNCTION enforce_submission_reviewed_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.review_outcome IS NOT NULL THEN
    RAISE EXCEPTION
      'Submission % (attempt %) was already reviewed as %; a review is recorded once (CA-1)',
      OLD.id, OLD.attempt_no, OLD.review_outcome
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER corrective_action_submission_reviewed_once
  BEFORE UPDATE ON corrective_action_submission
  FOR EACH ROW EXECUTE FUNCTION enforce_submission_reviewed_once();

/*
 * CA-2's other half: an Option A photograph is a **live** capture, taken **for this
 * action**, **for this attempt**, and not withdrawn.
 *
 * `is_live_capture` is deterrence plus evidence rather than proof (§12.10), and it is
 * still checked here: the flow demands live capture, and a row that says otherwise is the
 * one thing a reviewer would want refused rather than rendered.
 */
CREATE OR REPLACE FUNCTION enforce_submission_after_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  photo record;
BEGIN
  IF NEW.after_evidence_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT e.kind, e.is_live_capture, e.corrective_action_id,
         e.corrective_action_submission_id, e.deleted_at
    INTO photo
    FROM evidence e WHERE e.id = NEW.after_evidence_id;

  IF photo.kind IS DISTINCT FROM 'CORRECTIVE_AFTER'
     OR photo.corrective_action_id IS DISTINCT FROM NEW.corrective_action_id
     OR photo.corrective_action_submission_id IS DISTINCT FROM NEW.id
     OR photo.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Evidence % is not an after-photo taken for corrective action % attempt % (CA-2)',
      NEW.after_evidence_id, NEW.corrective_action_id, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT photo.is_live_capture THEN
    RAISE EXCEPTION
      'Evidence % was not a live capture; Option A requires one (CA-2, 12.10)',
      NEW.after_evidence_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER corrective_action_submission_after_evidence
  BEFORE INSERT ON corrective_action_submission
  FOR EACH ROW EXECUTE FUNCTION enforce_submission_after_evidence();

-- =============================================================================
-- Evidence: the after-photo's link, and R-10 reaching it at the right moment (R-13)
-- =============================================================================

/*
 * `corrective_action_submission_id` is §5.6's column and the key's segment, minted by the
 * device when the Option A form opens. It cannot carry a foreign key: the photograph is
 * uploaded *before* the attempt it belongs to exists — offline, possibly days before. The
 * link is enforced from the other side, by the trigger above, at the moment it matters.
 *
 * `corrective_action_id` is the column §5.6 did not have and the flow cannot do without:
 * before the attempt exists, it is the only way from an after-photo to the action whose
 * scope governs it — who may commit it, and who may see it.
 */
ALTER TABLE evidence
  ADD COLUMN corrective_action_id uuid NULL REFERENCES corrective_action(id) ON DELETE RESTRICT;

ALTER TABLE evidence
  ADD CONSTRAINT evidence_corrective_after_link CHECK (
    (kind = 'CORRECTIVE_AFTER'
      AND corrective_action_id IS NOT NULL AND corrective_action_submission_id IS NOT NULL)
    OR (kind <> 'CORRECTIVE_AFTER'
      AND corrective_action_id IS NULL AND corrective_action_submission_id IS NULL)
  );

CREATE INDEX evidence_corrective_action_idx ON evidence (corrective_action_id)
  WHERE corrective_action_id IS NOT NULL;

-- Whether an attempt cites this after-photo. SECURITY DEFINER so the answer does not
-- depend on what the invoker may read: "not cited" is the permissive answer here, and a
-- permissive answer must never be the result of an RLS policy hiding the row that says
-- otherwise.
CREATE OR REPLACE FUNCTION corrective_after_is_cited(p_evidence_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM corrective_action_submission s WHERE s.after_evidence_id = p_evidence_id
  );
$$;

REVOKE ALL ON FUNCTION corrective_after_is_cited(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION corrective_after_is_cited(uuid) TO audit5s_app;

-- The body of 0007's function with one exception added, beside the rule it bends. The
-- trigger and its six-column carve-out (0008) are untouched: CREATE OR REPLACE keeps them.
CREATE OR REPLACE FUNCTION enforce_completed_evidence_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed_columns text[] := COALESCE(TG_ARGV, ARRAY[]::text[]);
  frozen_statuses audit_status[] := ARRAY['COMPLETED','CORRECTIVE_ACTION_OPEN',
                                          'PARTIALLY_CLOSED','CLOSED']::audit_status[];
  audit_state    audit_status;
  changed_column text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Evidence is never deleted: a photo is soft-deleted before completion and redacted '
      'after it, and both keep the row (R-5, D8)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- R-13. An after-photo is taken after completion by definition; its own life — commit,
  -- a retake withdrawn before submitting — runs until an attempt cites it. From then on it
  -- is the record of what the Zone Leader submitted, and it freezes like any other.
  IF OLD.kind = 'CORRECTIVE_AFTER' AND NOT corrective_after_is_cited(OLD.id) THEN
    RETURN NEW;
  END IF;

  SELECT a.status INTO audit_state FROM audit a WHERE a.id = OLD.audit_id;

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
    IF changed_column = 'updated_at' THEN
      CONTINUE;
    END IF;

    IF NOT (changed_column = ANY (allowed_columns)) THEN
      RAISE EXCEPTION
        'Audit % is %: evidence.% may not be updated after completion. Redaction (R-5) '
        'is the only change a completed audit''s evidence accepts, and it overwrites the '
        'object while keeping the record',
        OLD.audit_id, audit_state, changed_column
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- Notifications (§5.9)
-- =============================================================================

CREATE TABLE notification (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The domain event that raised it. With the recipient, the dedupe key: pg-boss may
  -- deliver a job twice, and a Zone Leader must not be told twice.
  event_id           uuid NOT NULL,
  recipient_user_id  uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  -- Text, like `sync_conflict.reason`: a new event type must not need a migration.
  event_type         text NOT NULL,
  title              text NOT NULL,
  body               text NOT NULL,
  data               jsonb NOT NULL DEFAULT '{}'::jsonb,
  unit_id            uuid NULL REFERENCES unit(id) ON DELETE RESTRICT,
  resource_type      text NULL,
  resource_id        uuid NULL,
  read_at            timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX notification_event_recipient_key
  ON notification (event_id, recipient_user_id);
-- The notification centre's query.
CREATE INDEX notification_centre_idx
  ON notification (recipient_user_id, read_at, created_at DESC);

-- Marking read is the one change a notification takes.
CREATE TRIGGER notification_append_only
  BEFORE UPDATE OR DELETE ON notification
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only('read_at');

CREATE TABLE notification_delivery (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id          uuid NOT NULL REFERENCES notification(id) ON DELETE RESTRICT,
  channel                  notification_channel NOT NULL,
  status                   notification_status NOT NULL DEFAULT 'PENDING',
  -- §5.9: an SMS sent because WhatsApp failed is its own row, pointing at the failure, so
  -- the fallback is auditable rather than invisible.
  fallback_of_delivery_id  uuid NULL REFERENCES notification_delivery(id) ON DELETE RESTRICT,
  provider_message_id      text NULL,
  attempt_count            integer NOT NULL DEFAULT 0,
  last_error               text NULL,
  sent_at                  timestamptz NULL,
  delivered_at             timestamptz NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- One delivery per channel per notification: a redelivered job finds its rows.
CREATE UNIQUE INDEX notification_delivery_channel_key
  ON notification_delivery (notification_id, channel);
CREATE INDEX notification_delivery_retry_idx ON notification_delivery (status, created_at);

CREATE TRIGGER notification_delivery_set_updated_at BEFORE UPDATE ON notification_delivery
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notification_delivery_no_delete BEFORE DELETE ON notification_delivery
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

CREATE TABLE notification_preference (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  event_type  text NOT NULL,
  channel     notification_channel NOT NULL,
  enabled     boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX notification_preference_key
  ON notification_preference (user_id, event_type, channel);

CREATE TRIGGER notification_preference_set_updated_at BEFORE UPDATE ON notification_preference
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notification_preference_no_delete BEFORE DELETE ON notification_preference
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

/*
 * Who an event notifies, with what each has switched off.
 *
 * The notification worker has no actor of its own — there is no system bypass in this
 * schema, by design — and the rows it needs are ones no single actor may read: every
 * Super Admin, a Unit's Coordinator, another user's preferences. So, like
 * `app_zone_leader_name()` in 0008, the lookup is a narrow SECURITY DEFINER function: it
 * returns ids, roles and two switches, for active, unarchived accounts, and nothing else —
 * no names, no phone numbers, no login ids.
 *
 * `p_roles` names roles whose holders are notified: SUPER_ADMIN organisation-wide, every
 * other role through an ACTIVE membership of `p_unit_id`. `p_user_ids` names people
 * directly (the assignee, the submitter). The worker then writes each notification as its
 * recipient, so the rows themselves stay behind ordinary own-record policies.
 */
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

REVOKE ALL ON FUNCTION app_notification_targets(text, uuid, role[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notification_targets(text, uuid, role[], uuid[]) TO audit5s_app;

-- =============================================================================
-- Row-level security — PART 6.3, as defence in depth behind the ScopeGuard
-- =============================================================================

ALTER TABLE corrective_action            ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrective_action_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery        ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preference      ENABLE ROW LEVEL SECURITY;

-- Whether the actor may answer this corrective action: a Zone Leader it is assigned to,
-- or any Zone Leader of its Unit (R-3b — deliberately wide, so an action cannot stall).
CREATE OR REPLACE FUNCTION app_may_answer_corrective_action(p_action_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_actor_role() = 'ZONE_LEADER' AND EXISTS (
    SELECT 1 FROM corrective_action ca
    WHERE ca.id = p_action_id
      AND (ca.assigned_zone_leader_user_id = app_actor_id()
           OR ca.unit_id = ANY (app_actor_unit_ids()))
  );
$$;

-- --- corrective_action -------------------------------------------------------
CREATE POLICY corrective_action_select ON corrective_action FOR SELECT
  USING (
    app_is_super_admin()
    OR unit_id = ANY (app_actor_unit_ids())
    OR assigned_zone_leader_user_id = app_actor_id()
    -- A Consultant reads the items their own audit raised.
    OR EXISTS (SELECT 1 FROM audit a
               WHERE a.id = corrective_action.audit_id AND a.auditor_user_id = app_actor_id())
  );

-- Materialised on the completing auditor's own transaction.
CREATE POLICY corrective_action_insert ON corrective_action FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM audit a
            WHERE a.id = corrective_action.audit_id AND a.auditor_user_id = app_actor_id())
  );

-- The Zone Leader clause is `app_may_answer_corrective_action()` written against this
-- row's own columns, so the policy does not query the table it guards.
CREATE POLICY corrective_action_update ON corrective_action FOR UPDATE
  USING (
    app_is_super_admin()
    OR (app_actor_role() = 'COORDINATOR' AND unit_id = ANY (app_actor_unit_ids()))
    OR (app_actor_role() = 'ZONE_LEADER'
        AND (assigned_zone_leader_user_id = app_actor_id()
             OR unit_id = ANY (app_actor_unit_ids())))
  );

-- --- corrective_action_submission -------------------------------------------
CREATE POLICY corrective_action_submission_select ON corrective_action_submission FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM corrective_action ca
            WHERE ca.id = corrective_action_submission.corrective_action_id)
  );

CREATE POLICY corrective_action_submission_insert ON corrective_action_submission FOR INSERT
  WITH CHECK (
    submitted_by_user_id = app_actor_id()
    AND app_may_answer_corrective_action(corrective_action_id)
  );

CREATE POLICY corrective_action_submission_update ON corrective_action_submission FOR UPDATE
  USING (app_is_super_admin());

-- --- evidence: the Zone Leader's after-photo ---------------------------------
-- Permissive policies OR with 0007's, which admit only the audit's own auditor. An
-- after-photo is taken by whoever answers the action, who is rarely that auditor.
CREATE POLICY evidence_insert_corrective_after ON evidence FOR INSERT
  WITH CHECK (kind = 'CORRECTIVE_AFTER' AND app_may_answer_corrective_action(corrective_action_id));

CREATE POLICY evidence_update_corrective_after ON evidence FOR UPDATE
  USING (kind = 'CORRECTIVE_AFTER' AND app_may_answer_corrective_action(corrective_action_id));

-- --- notifications -----------------------------------------------------------
-- Every one of these is the recipient's own: the worker writes as the recipient.
CREATE POLICY notification_select ON notification FOR SELECT
  USING (recipient_user_id = app_actor_id());
CREATE POLICY notification_insert ON notification FOR INSERT
  WITH CHECK (recipient_user_id = app_actor_id());
CREATE POLICY notification_update ON notification FOR UPDATE
  USING (recipient_user_id = app_actor_id());

CREATE POLICY notification_delivery_select ON notification_delivery FOR SELECT
  USING (
    app_is_super_admin()
    OR EXISTS (SELECT 1 FROM notification n
               WHERE n.id = notification_delivery.notification_id
                 AND n.recipient_user_id = app_actor_id())
  );
CREATE POLICY notification_delivery_insert ON notification_delivery FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM notification n
            WHERE n.id = notification_delivery.notification_id
              AND n.recipient_user_id = app_actor_id())
  );
CREATE POLICY notification_delivery_update ON notification_delivery FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM notification n
            WHERE n.id = notification_delivery.notification_id
              AND n.recipient_user_id = app_actor_id())
  );

CREATE POLICY notification_preference_own ON notification_preference FOR ALL
  USING (user_id = app_actor_id())
  WITH CHECK (user_id = app_actor_id());

-- =============================================================================
-- Grants — no DELETE on any of the five (D8, AL-1). The triggers refuse it anyway.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE ON corrective_action            TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON corrective_action_submission TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON notification                 TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON notification_delivery        TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON notification_preference      TO audit5s_app;
