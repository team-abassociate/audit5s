-- =============================================================================
-- 0007_evidence_and_sync
--
-- Phase 4 schema (ARCHITECTURE.md PART 14): evidence, and the two tables that make
-- offline synchronization diagnosable and lossless.
--
-- Tables: evidence, device_sync_record, sync_conflict.
--
-- It also closes the seam 0006 left: `audit.selfie_evidence_id` has been a bare `uuid`
-- with no foreign key since Phase 3, because there was no `evidence` table to point at.
-- The constraint is added here, alongside the table it references.
--
-- Four rules are database guarantees in this file rather than service conventions:
--
--   * R-5 — the `evidence` append-only trigger ships **with** the table, already carrying
--     the three-column redaction carve-out. Erasure is redaction, never deletion. See the
--     note above the trigger for why this needs its own status-aware function rather than
--     `enforce_append_only()` directly (DECISIONS.md R-10).
--   * E-3 — `is_summary_flagged` requires a GOOD or NONCONFORMITY classification, as a CHECK.
--   * The two partial unique indexes of §5.6 — at most one flagged GOOD and one flagged
--     NONCONFORMITY per Zone. Enforcing this in the database rather than in application
--     logic means a **duplicated sync request cannot produce two flagged photos**, which
--     is the whole reason §5.6 puts it here.
--   * Layer 3 of §9.5 — `sync_conflict` is never deleted from. "The system has no code
--     path that drops field data on the floor" is the single most important property of
--     the sync design, and a missing DELETE grant plus a trigger is how it is kept.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums (§5.1), added alongside the tables that reference them.
-- -----------------------------------------------------------------------------
CREATE TYPE evidence_kind AS ENUM
  ('AUDITOR_SELFIE','QUESTION_EVIDENCE','WALK_BY_PHOTO','CORRECTIVE_AFTER');

CREATE TYPE evidence_classification AS ENUM ('GOOD','NONCONFORMITY','NEUTRAL');

-- =============================================================================
-- Evidence (§5.6)
-- =============================================================================

CREATE TABLE evidence (
  -- Client-generated UUIDv7, like every other row a device authors (D12). It is also
  -- what makes a retried upload intent return the *same* object key rather than minting
  -- a second one and orphaning the first.
  id                       uuid PRIMARY KEY,
  kind                     evidence_kind NOT NULL,
  audit_id                 uuid NOT NULL REFERENCES audit(id) ON DELETE RESTRICT,
  -- Null only for the audit-level selfie.
  audit_zone_id            uuid NULL REFERENCES audit_zone(id) ON DELETE RESTRICT,
  -- Present for QUESTION_EVIDENCE (C8); null for walk-by and selfie. This is the link
  -- E-1 classifies from and E-2 reclassifies through.
  question_response_id     uuid NULL REFERENCES question_response(id) ON DELETE RESTRICT,
  -- The FK lands with `corrective_action_submission` in Phase 6, for the same reason
  -- `selfie_evidence_id` waited for this table: the referent does not exist yet.
  corrective_action_submission_id uuid NULL,

  object_key               text NOT NULL,
  thumbnail_object_key     text NULL,
  content_type             text NOT NULL,
  byte_size                bigint NOT NULL,
  width                    integer NULL,
  height                   integer NULL,
  -- Upload dedupe and tamper evidence. Verified at commit against the object the
  -- storage provider actually holds (§9.4).
  checksum_sha256          text NOT NULL,

  local_device_id          uuid NULL REFERENCES device(id) ON DELETE RESTRICT,
  -- Device-side path, retained for support diagnostics only. Never fetched by the server.
  local_file_uri           text NULL,

  -- The score at the moment the photo was taken. Invariant E-1 derives `classification`
  -- from this; E-2 recomputes both when the response changes before completion.
  score_at_capture         response_value NULL,
  classification           evidence_classification NOT NULL DEFAULT 'NEUTRAL',
  remark                   text NULL,
  is_summary_flagged       boolean NOT NULL DEFAULT false,

  latitude                 numeric(9,6) NULL,
  longitude                numeric(9,6) NULL,
  accuracy_m               numeric(8,2) NULL,
  location_provider        location_provider NULL,
  captured_at              timestamptz NOT NULL,
  uploaded_at              timestamptz NULL,
  sync_state               sync_state NOT NULL DEFAULT 'SYNCING',
  -- False ⇒ gallery. §12.10 states plainly that this is deterrence plus evidence and not
  -- prevention: a modified build can set it. It is recorded, shown to reviewers, and
  -- never described as proof.
  is_live_capture          boolean NOT NULL DEFAULT false,

  -- Pre-completion soft delete only (E-4). After completion the endpoint returns 409 and
  -- the trigger below refuses the write regardless.
  deleted_at               timestamptz NULL,
  deleted_by_user_id       uuid NULL REFERENCES "user"(id) ON DELETE RESTRICT,

  -- R-5. The erasure path: the stored object is overwritten with a placeholder and the
  -- row survives, so the record still says a photo was present and who removed it.
  redacted_at              timestamptz NULL,
  redacted_by_user_id      uuid NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  redaction_reason         text NULL,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- Invariant E-3. A NEUTRAL photo has no report section to be the summary of, so
  -- flagging one is not a preference the UI should be free to express.
  CONSTRAINT evidence_e3_summary_flag CHECK (
    NOT is_summary_flagged OR classification IN ('GOOD','NONCONFORMITY')
  ),

  -- C8: question evidence names the response it belongs to; a selfie never does.
  CONSTRAINT evidence_question_link CHECK (
    (kind = 'QUESTION_EVIDENCE') OR question_response_id IS NULL
  ),

  -- §5.6: `audit_zone_id` is null only for the audit-level selfie.
  CONSTRAINT evidence_zone_link CHECK (
    kind = 'AUDITOR_SELFIE' OR kind = 'CORRECTIVE_AFTER' OR audit_zone_id IS NOT NULL
  )
);

-- Content-addressed and server-minted: one object, one row, always.
CREATE UNIQUE INDEX evidence_object_key_key ON evidence (object_key);

CREATE INDEX evidence_zone_classification_idx
  ON evidence (audit_zone_id, classification) WHERE deleted_at IS NULL;
CREATE INDEX evidence_question_response_idx ON evidence (question_response_id);
CREATE INDEX evidence_audit_kind_idx ON evidence (audit_id, kind);
-- Upload dedupe: the same bytes photographed twice in one audit.
CREATE INDEX evidence_checksum_idx ON evidence (checksum_sha256, audit_id);
-- §9.4's `orphan_metadata` sweep: a row whose object never arrived.
CREATE INDEX evidence_awaiting_upload_idx
  ON evidence (sync_state, created_at) WHERE sync_state <> 'SYNCED' AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- The two partial unique indexes of §5.6.
--
-- These *are* the rule "one optional flagged GOOD image and one optional flagged
-- NONCONFORMITY image per Zone". §5.6 explains why they live here rather than in a
-- service: enforcing it in application logic means a duplicated sync request — which is
-- the normal case on a weak connection, not an edge case — can produce two flagged
-- photos, and the summary report then has to pick one arbitrarily.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX evidence_one_flagged_good_per_zone
  ON evidence (audit_zone_id)
  WHERE is_summary_flagged AND classification = 'GOOD' AND deleted_at IS NULL;

CREATE UNIQUE INDEX evidence_one_flagged_nonconformity_per_zone
  ON evidence (audit_zone_id)
  WHERE is_summary_flagged AND classification = 'NONCONFORMITY' AND deleted_at IS NULL;

CREATE TRIGGER evidence_set_updated_at BEFORE UPDATE ON evidence
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Invariant R-5 / D8 — evidence is append-only *after* completion, with a carve-out.
--
-- DECISIONS.md R-5 requires that the evidence trigger carry the three-column redaction
-- carve-out from the moment the table is created, and `enforce_append_only()` in 0001
-- takes that carve-out as trigger arguments precisely so it can be passed here.
--
-- It cannot be attached directly, and the reason is the same one A-2 ran into in 0006:
-- `enforce_append_only()` is unconditional, and a table wearing it is frozen from its
-- first row. Evidence has a whole life before an audit completes — commit sets
-- `sync_state` and `uploaded_at`, E-2 rewrites `classification`, the auditor toggles the
-- summary flag, E-4 soft-deletes. Freezing all of that would make the table unusable.
--
-- D8 names "post-completion `Evidence`", so the rule is conditional exactly as A-2 is.
-- This function is `enforce_completed_audit_append_only()`'s shape with the carve-out
-- read from `TG_ARGV` — the same mechanism 0001 parameterised, applied at the point D8
-- actually bites. The three column names are passed by the CREATE TRIGGER below, so the
-- carve-out is structural and there is never a moment where a carve-out-less trigger is
-- live over real evidence. Recorded as DECISIONS.md R-10.
--
-- DELETE has no carve-out at any level, for anyone, under any flag: evidence is
-- soft-deleted before completion and redacted after it, and neither removes the row.
-- -----------------------------------------------------------------------------
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

  SELECT a.status INTO audit_state FROM audit a WHERE a.id = OLD.audit_id;

  -- Before completion the auditor is still working: commit, reclassify, flag, soft-delete.
  IF NOT (audit_state = ANY (frozen_statuses)) THEN
    RETURN NEW;
  END IF;

  -- The A-2 override path reaches evidence too, so quarantined field work can be applied
  -- to a completed audit through the one door that writes an AuditLog entry.
  IF app_post_completion_override() THEN
    RETURN NEW;
  END IF;

  FOR changed_column IN
    SELECT key
    FROM jsonb_each(to_jsonb(OLD)) AS o(key, value)
    WHERE o.value IS DISTINCT FROM (to_jsonb(NEW) -> o.key)
  LOOP
    -- `updated_at` is written by the set_updated_at trigger on every UPDATE, so a
    -- permitted redaction would otherwise fail on the column its own trigger changed.
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

-- The R-5 carve-out, passed as trigger arguments exactly as 0001 anticipated.
CREATE TRIGGER evidence_append_only_after_completion
  BEFORE UPDATE OR DELETE ON evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_completed_evidence_append_only(
    'redacted_at', 'redacted_by_user_id', 'redaction_reason'
  );

-- -----------------------------------------------------------------------------
-- The Phase 3 seam, closed.
--
-- 0006 shipped `audit.selfie_evidence_id` as a bare uuid because `evidence` did not
-- exist. It does now, so the column becomes a real reference and a selfie id that names
-- nothing is refused by the database rather than by whichever service remembered to look.
-- -----------------------------------------------------------------------------
ALTER TABLE audit
  ADD CONSTRAINT audit_selfie_evidence_fk
  FOREIGN KEY (selfie_evidence_id) REFERENCES evidence(id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

-- Deferrable because the selfie and the audit are written in one transaction and each
-- references the other: `evidence.audit_id` needs the audit row, and
-- `audit.selfie_evidence_id` needs the evidence row. Deferring this side lets the pair
-- commit together instead of forcing an UPDATE after the fact.

-- =============================================================================
-- device_sync_record (§5.9)
--
-- One row per sync batch: the operational telemetry that makes a field problem
-- diagnosable. Without it, "the audit never arrived" is unanswerable — with it, the
-- question is which batch, when, from which device, and what the server said.
-- =============================================================================

CREATE TABLE device_sync_record (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id        uuid NOT NULL REFERENCES device(id) ON DELETE RESTRICT,
  user_id          uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  direction        text NOT NULL DEFAULT 'PUSH',
  -- UNIQUE: this is what makes a replayed batch return its stored verdicts instead of
  -- applying twice. §9.3 says a duplicate batchId creates no duplicates, and this index
  -- is the enforcement — not the service's memory of having seen it.
  batch_id         uuid NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz NULL,
  item_count       integer NOT NULL DEFAULT 0,
  accepted_count   integer NOT NULL DEFAULT 0,
  rejected_count   integer NOT NULL DEFAULT 0,
  conflict_count   integer NOT NULL DEFAULT 0,
  bytes_uploaded   bigint  NOT NULL DEFAULT 0,
  status           text    NOT NULL DEFAULT 'IN_PROGRESS',
  error            text    NULL,
  app_version      text    NULL,
  network_type     text    NULL,
  -- The verdicts themselves, so a replay answers from storage rather than by reapplying.
  results          jsonb   NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT device_sync_record_direction CHECK (direction IN ('PUSH','PULL'))
);

CREATE UNIQUE INDEX device_sync_record_batch_key ON device_sync_record (batch_id);
CREATE INDEX device_sync_record_device_idx ON device_sync_record (device_id, started_at DESC);
CREATE INDEX device_sync_record_user_status_idx ON device_sync_record (user_id, status);

CREATE TRIGGER device_sync_record_set_updated_at BEFORE UPDATE ON device_sync_record
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- sync_conflict (§5.9, §9.5 Layer 3) — quarantine, never silent loss
--
-- > A rejected sync item is **never dropped**. It lands here with its full payload so a
-- > Super Admin can inspect and, if warranted, apply it through the post-completion
-- > override path.
--
-- `incoming_payload` is `NOT NULL` for that reason: a quarantine row without the payload
-- is a record that something was lost, which is worse than useless. The column is the
-- point of the table.
-- =============================================================================

CREATE TABLE sync_conflict (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable because a conflict can outlive the device row it came from; the payload
  -- must survive a device being revoked and removed from an inventory.
  device_id           uuid NULL REFERENCES device(id) ON DELETE RESTRICT,
  user_id             uuid NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  entity_type         text NOT NULL,
  entity_id           uuid NOT NULL,
  -- Text rather than an enum: §5.9 lists five reasons and this is a diagnostic record,
  -- not a state machine. A sixth reason must not require a migration to record.
  reason              text NOT NULL,
  incoming_payload    jsonb NOT NULL,
  existing_payload    jsonb NULL,
  -- The batch it arrived in, so a conflict can be traced back to its telemetry row.
  batch_id            uuid NULL,
  resolved_at         timestamptz NULL,
  resolved_by_user_id uuid NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  resolution          text NULL,
  resolution_note     text NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sync_conflict_resolution CHECK (
    resolution IS NULL OR resolution IN ('APPLY','DISCARD')
  ),
  -- A resolution without a resolver, or vice versa, is a half-recorded decision.
  CONSTRAINT sync_conflict_resolved_together CHECK (
    (resolved_at IS NULL) = (resolved_by_user_id IS NULL)
  )
);

CREATE INDEX sync_conflict_unresolved_idx ON sync_conflict (resolved_at, created_at);
CREATE INDEX sync_conflict_entity_idx ON sync_conflict (entity_type, entity_id);
CREATE INDEX sync_conflict_user_idx ON sync_conflict (user_id);
CREATE INDEX sync_conflict_device_idx ON sync_conflict (device_id, created_at DESC);

CREATE TRIGGER sync_conflict_set_updated_at BEFORE UPDATE ON sync_conflict
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The property the whole design rests on, as a trigger. `enforce_no_delete()` is 0006's,
-- reused rather than rewritten: a quarantined payload is field work that could not be
-- applied, and the one thing that must never happen to it is disappearing.
CREATE TRIGGER sync_conflict_no_delete
  BEFORE DELETE ON sync_conflict
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

CREATE TRIGGER device_sync_record_no_delete
  BEFORE DELETE ON device_sync_record
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

-- =============================================================================
-- Row-level security
--
-- Defence in depth behind the ScopeGuard, mirroring PART 6.3.
--
-- Evidence follows its audit exactly: a Super Admin sees everything, a Consultant their
-- own audits, a Coordinator and a Zone Leader their Unit's. Writes are narrower — only
-- the auditor writes evidence for their own audit.
--
-- `sync_conflict` is stricter than most tables and deliberately asymmetric: PART 6.3
-- grants `sync_conflict:read` to SUPER_ADMIN alone, but the *insert* happens while a
-- Consultant's own batch is being processed, under that Consultant's actor context. So
-- INSERT admits the owner of the payload and SELECT does not: a device may create the
-- record of its own rejected work, and only a Super Admin may read the queue.
-- =============================================================================

ALTER TABLE evidence            ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_sync_record  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_conflict       ENABLE ROW LEVEL SECURITY;

-- --- evidence ----------------------------------------------------------------
CREATE POLICY evidence_select ON evidence FOR SELECT
  USING (
    app_is_super_admin()
    OR EXISTS (
      SELECT 1 FROM audit a
      WHERE a.id = evidence.audit_id
        AND (a.auditor_user_id = app_actor_id() OR a.unit_id = ANY (app_actor_unit_ids()))
    )
  );

CREATE POLICY evidence_insert ON evidence FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM audit a
            WHERE a.id = evidence.audit_id AND a.auditor_user_id = app_actor_id())
  );

CREATE POLICY evidence_update ON evidence FOR UPDATE
  USING (
    app_is_super_admin()
    OR EXISTS (SELECT 1 FROM audit a
               WHERE a.id = evidence.audit_id AND a.auditor_user_id = app_actor_id())
  );

-- --- device_sync_record ------------------------------------------------------
CREATE POLICY device_sync_record_select ON device_sync_record FOR SELECT
  USING (app_is_super_admin() OR user_id = app_actor_id());

CREATE POLICY device_sync_record_insert ON device_sync_record FOR INSERT
  WITH CHECK (user_id = app_actor_id());

CREATE POLICY device_sync_record_update ON device_sync_record FOR UPDATE
  USING (app_is_super_admin() OR user_id = app_actor_id());

-- --- sync_conflict -----------------------------------------------------------
CREATE POLICY sync_conflict_select ON sync_conflict FOR SELECT
  USING (app_is_super_admin());

CREATE POLICY sync_conflict_insert ON sync_conflict FOR INSERT
  WITH CHECK (user_id = app_actor_id());

CREATE POLICY sync_conflict_update ON sync_conflict FOR UPDATE
  USING (app_is_super_admin());

-- =============================================================================
-- Grants
--
-- **No DELETE on any of the three.** Evidence is soft-deleted and redacted; a sync
-- conflict and its telemetry are permanent. The triggers refuse a DELETE; the missing
-- grant means the statement never reaches the trigger. Both, deliberately (AL-1).
-- =============================================================================

GRANT SELECT, INSERT, UPDATE ON evidence TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON device_sync_record TO audit5s_app;
GRANT SELECT, INSERT, UPDATE ON sync_conflict TO audit5s_app;
