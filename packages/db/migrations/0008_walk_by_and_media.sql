-- =============================================================================
-- 0008_walk_by_and_media
--
-- Phase 5 schema (ARCHITECTURE.md PART 14): what a walk-by is *not*, and what the media
-- worker needs to record.
--
-- The Phase 5 migration row reads "Walk-by-specific constraints; thumbnail key column".
-- The second half was already done: `thumbnail_object_key` shipped with the table in
-- `0007`, because the column belongs beside the object key it describes. There is no
-- second one here.
--
-- The first half needed deciding rather than filling in. `checklist_version_id` is already
-- nullable on both `audit` and `audit_zone`, so a walk-by Zone needs no schema change to
-- *have* no questionnaire — which raised the real question: is there anything a database
-- should refuse that it currently permits? There is, and it is the inverse of what the row
-- sounds like. Nothing stops a walk-by audit from pinning a checklist version today, and
-- nothing stops a `question_response` from being written against a Zone that pinned none.
-- Both are "no questionnaire, no score" (§2.7) failing silently rather than loudly: a
-- walk-by with fifty answers would be scored by PART 11 as though it were an audit.
--
--   * `audit_walk_by_has_no_checklist` — §5.5's "`checklist_version_id` — Null for
--     `WALK_BY`", as a CHECK.
--   * `audit_zone_walk_by_has_no_checklist` — the same rule one level down, where the
--     *binding* version lives (QR-2). A trigger rather than a CHECK because `audit_zone`
--     does not carry the audit type, and duplicating it onto the row to make a CHECK
--     possible would be a second copy of a fact that can then disagree with the first.
--   * `question_response_requires_pinned_version` — QR-2 as a database guarantee: an
--     answer needs its Zone's pinned version. Stated type-agnostically on purpose; "a
--     walk-by has no answers" then follows from the trigger above rather than being a
--     second rule that could drift from it.
--
-- The media half:
--
--   * `stored_checksum_sha256` and `media_processed_at`, which the worker writes.
--   * The R-10 trigger is **recreated** with those two columns and `thumbnail_object_key`
--     added to its carve-out. That is a change to the argument list, which is why it is a
--     migration and not an edit to `0007`: the append-only carve-out is exactly the set of
--     columns named in a `CREATE TRIGGER`, and widening it is a decision with a record
--     (DECISIONS.md R-12).
-- =============================================================================

-- =============================================================================
-- Walk-by: no questionnaire (§2.7, §5.5, QR-2)
-- =============================================================================

-- §5.5: "`checklist_version_id` — `uuid` FK NULL — Null for `WALK_BY`. Audit-level
-- default; the binding one is on `audit_zone`." §7.1's `READY → IN_PROGRESS` guard says
-- the same thing from the other side: "published checklist version exists (non-walk-by)".
ALTER TABLE audit
  ADD CONSTRAINT audit_walk_by_has_no_checklist CHECK (
    audit_type <> 'WALK_BY' OR checklist_version_id IS NULL
  );

/*
 * The binding version (QR-2) is the one on `audit_zone`, and it is the one that matters:
 * an audit-level default that no Zone used would be harmless, while a Zone that pinned a
 * version is a Zone whose questions the report will try to render.
 *
 * `audit_zone` has no `audit_type`. Denormalising one onto the row to make this a CHECK
 * would create a second copy of the audit's type that could disagree with the first —
 * which is the failure D6 avoids by snapshotting only what history needs and nothing that
 * can contradict a live row.
 */
CREATE OR REPLACE FUNCTION enforce_walk_by_has_no_checklist() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_type audit_type;
BEGIN
  IF NEW.checklist_version_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT a.audit_type INTO parent_type FROM audit a WHERE a.id = NEW.audit_id;

  IF parent_type = 'WALK_BY' THEN
    RAISE EXCEPTION
      'Audit % is a WALK_BY: a walk-by Zone has no questionnaire, so it cannot pin a '
      'checklist version (2.7, 5.5)', NEW.audit_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_zone_walk_by_has_no_checklist
  BEFORE INSERT OR UPDATE OF checklist_version_id ON audit_zone
  FOR EACH ROW EXECUTE FUNCTION enforce_walk_by_has_no_checklist();

/*
 * QR-2, as a guarantee rather than a service convention.
 *
 * `question_response` names a Zone and a question but not a version, so the database has
 * so far had no way to refuse an answer written against a Zone that pinned no
 * questionnaire. `ResponsesService` refuses it with a 422, and `/sync/batch` goes through
 * that same service (AZ-5) — but "no path in today's code does this" is a weaker statement
 * than "the row cannot exist", and this is a row Phase 7 renders and Phase 8 averages.
 *
 * Stated as "an answer needs its Zone's pinned version" rather than as "a walk-by has no
 * answers": the two are the same rule here, and the type-agnostic form is one lookup
 * instead of two — `audit_zone` is already being touched by this INSERT's own foreign key,
 * so the row is in cache. That matters: this is the hottest write in the system, fifty per
 * Zone.
 */
CREATE OR REPLACE FUNCTION enforce_response_has_pinned_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pinned uuid;
BEGIN
  SELECT az.checklist_version_id INTO pinned FROM audit_zone az WHERE az.id = NEW.audit_zone_id;

  IF pinned IS NULL THEN
    RAISE EXCEPTION
      'Audit Zone % has no checklist version pinned to it, so it has no questions to '
      'answer (QR-2). A walk-by Zone records photographs, not responses (2.7)',
      NEW.audit_zone_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER question_response_requires_pinned_version
  BEFORE INSERT OR UPDATE OF audit_zone_id ON question_response
  FOR EACH ROW EXECUTE FUNCTION enforce_response_has_pinned_version();

-- =============================================================================
-- The Zone Leader's display name, readable without reading their user record
--
-- §2.7 step 4 is "Zone leader — confirmed/selected, **snapshotted**", and D6 makes that
-- snapshot include the *name*, "so it survives even a user rename". Phase 5 is the first
-- flow that lets an auditor choose one, and building it surfaced a gap that has been there
-- since Phase 3: `zone_leader_name_snapshot` is silently `NULL` whenever the Zone is added
-- by a Consultant.
--
-- The cause is `user_select`, and it is not a mistake. PART 6 gives a Consultant `own_record`
-- on `user:read`, so the policy admits their own row and no other; a `LEFT JOIN "user"` for
-- the leader's name therefore yields `NULL` rather than an error. The same is true of
-- `GET /zones` and `GET /sync/catalogue`, so a device caches Zones whose leader has no name.
--
-- Widening `user_select` would be the wrong fix twice over: it would contradict PART 6, and
-- it would hand out a user *record* to get at a display string.
--
-- So the string is exposed on its own, through the mechanism `0001` already uses for
-- `app_actor_unit_ids()`: a narrow `SECURITY DEFINER` function. It returns the full name of
-- an **active `ZONE_LEADER` of the named Unit** and nothing else — no phone, no login ID, no
-- status — and only for a Unit the caller is a member of, so it leaks nothing a Zone read did
-- not already intend to give them. `zones.repository.ts` states that intent outright: "the
-- name is denormalised into every read because both clients show it and the device caches it
-- for offline browsing".
--
-- `NULL` therefore means one of two things and the callers want both: there is no such active
-- leader in that Unit, or the caller may not see that Unit. Either way the answer is the same
-- — no name to snapshot, and a selected leader that is refused (`ZONE_LEADER_NOT_IN_UNIT`).
-- =============================================================================

CREATE OR REPLACE FUNCTION app_zone_leader_name(p_unit_id uuid, p_user_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.full_name
  FROM "user" u
  JOIN unit_membership m ON m.user_id = u.id
  WHERE u.id = p_user_id
    AND m.unit_id = p_unit_id
    AND m.role = 'ZONE_LEADER'
    AND m.status = 'ACTIVE'
    AND now() >= m.valid_from
    AND (m.valid_to IS NULL OR now() < m.valid_to)
    -- The caller's own scope, inside the definer function, so bypassing RLS to read one
    -- display string cannot become a way to enumerate another Unit's people.
    AND (app_is_super_admin() OR m.unit_id = ANY (app_actor_unit_ids()))
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION app_zone_leader_name(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_zone_leader_name(uuid, uuid) TO audit5s_app;

-- =============================================================================
-- The media worker's two columns (§5.6, §12.8, STACK.md §5)
-- =============================================================================

ALTER TABLE evidence
  -- When the worker finished. Null means the thumbnail is not there *yet* — queued, or
  -- retrying — which a gallery renders as the original rather than as a broken image.
  --
  -- It is also what makes the job idempotent without a second table: pg-boss may deliver
  -- a job twice, and a worker that would otherwise re-encode and re-upload on every
  -- delivery can see that it has already been here.
  ADD COLUMN media_processed_at timestamptz NULL,

  -- The checksum of the object **as stored**, set only when the worker had to rewrite it.
  --
  -- STACK.md §5 asks the server to "re-encode to strip EXIF ... and record the SHA-256",
  -- and this is that record — separate from `checksum_sha256` rather than overwriting it,
  -- for two reasons.
  --
  -- First, `checksum_sha256` is §12.8's tamper control: "recorded at capture and verified
  -- at commit". It is a historical fact about what the device sent, already verified, and
  -- overwriting it would erase the only evidence of what was verified.
  --
  -- Second, `commit` is idempotent by contract (§9.6 makes replaying it the recovery path
  -- for an app killed between the PUT and the confirmation). It HEADs the object and
  -- compares. With the object sanitised and only one checksum column, that replay would
  -- answer `409 CHECKSUM_MISMATCH` for a photograph that is perfectly fine — the device
  -- would retry forever and dead-letter a good upload.
  --
  -- Null is the normal case: the device already strips at capture (§9.4), so there is
  -- nothing to remove and the bytes in storage stay the bytes the checksum describes.
  -- Non-null therefore also *reports* something — that a device sent metadata it should
  -- not have — which is the diagnostic worth keeping.
  ADD COLUMN stored_checksum_sha256 text NULL;

-- The gallery's read: one audit, optionally one classification, never the deleted.
-- `evidence_zone_classification_idx` already serves the per-Zone view; the per-audit
-- gallery and the summary report's flagged-photo query both start from the audit.
CREATE INDEX evidence_audit_classification_idx
  ON evidence (audit_id, classification) WHERE deleted_at IS NULL;

-- =============================================================================
-- R-10's carve-out, widened by three columns (DECISIONS.md R-12)
--
-- `0007` attached `enforce_completed_evidence_append_only()` with R-5's three redaction
-- columns as its arguments, and the carve-out *is* that argument list — the function reads
-- it from `TG_ARGV` precisely so the exception is visible where the rule is attached.
--
-- The media worker writes `thumbnail_object_key`, `media_processed_at` and
-- `stored_checksum_sha256`, and it runs asynchronously: a device that pushes a batch
-- containing both the last photograph and the audit's completion will have the audit
-- COMPLETED before the job is picked up. Without these three names the job would fail on
-- every attempt and dead-letter, leaving the audit's photographs with no thumbnails — and
-- the failure would look like a worker bug rather than a trigger doing its job.
--
-- Three things make widening it safe rather than a hole in D8:
--
--   * All three are **server-derived**. No API shape accepts any of them; they are written
--     by one worker from the object's own bytes.
--   * None is an audited fact. A thumbnail is a smaller copy of an image the row already
--     names, a processed-at is bookkeeping, and a stored checksum describes the object
--     rather than the finding. Nothing a report asserts or a corrective action answers
--     changes when any of them is written.
--   * The columns the rule exists to freeze are untouched: `classification`,
--     `score_at_capture`, `is_summary_flagged`, `remark`, `object_key`,
--     `checksum_sha256`, `captured_at`, the location columns and `deleted_at` all still
--     refuse an UPDATE after completion, and DELETE still has no carve-out at any level.
--
-- The function body is unchanged. Only the arguments are, which is the point of having
-- parameterised it.
-- =============================================================================

DROP TRIGGER evidence_append_only_after_completion ON evidence;

CREATE TRIGGER evidence_append_only_after_completion
  BEFORE UPDATE OR DELETE ON evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_completed_evidence_append_only(
    'redacted_at', 'redacted_by_user_id', 'redaction_reason',
    'thumbnail_object_key', 'media_processed_at', 'stored_checksum_sha256'
  );
