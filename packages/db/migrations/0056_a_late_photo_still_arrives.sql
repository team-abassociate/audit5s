-- =============================================================================
-- 0056 — A photo whose bytes arrive after its audit is completed is still recorded
--
-- Owner, 2026-10-26. A photo that gave up on the phone after every automatic try no longer
-- holds the audit's finish (the auditor is told and offered a Retry), and a photo can now be
-- recovered from the phone's backup folder after the app is reinstalled. Either way its
-- `commit` can land on a completed audit — and 0008's guard refused it, so the bytes were in
-- the bucket and the record said they never came.
--
-- The carve-out is the arrival and nothing else: a row not yet SYNCED, with no
-- `uploaded_at`, becoming SYNCED with one, changing only the columns `commit` writes. It can
-- happen once per photo. Every other change to a completed audit's evidence is refused
-- exactly as before (A-2), and redaction keeps its own carve-out through the trigger's
-- arguments.
-- =============================================================================

CREATE OR REPLACE FUNCTION enforce_completed_evidence_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed_columns text[] := COALESCE(TG_ARGV, ARRAY[]::text[]);
  frozen_statuses audit_status[] := ARRAY['COMPLETED','CORRECTIVE_ACTION_OPEN',
                                          'PARTIALLY_CLOSED','CLOSED']::audit_status[];
  -- What `commit` writes when the bytes are confirmed (EvidenceRepository.markCommitted).
  arrival_columns text[] := ARRAY['sync_state','uploaded_at','classification',
                                  'score_at_capture','byte_size','width','height'];
  audit_state    audit_status;
  arriving       boolean;
  changed_column text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Evidence is never deleted: a photo is soft-deleted before completion and redacted '
      'after it, and both keep the row (R-5, D8)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- R-13. An after-photo is taken after completion by definition; its own life — the
  -- commit, the media worker — runs until an attempt cites it. From then on it is the
  -- record of what the Zone Leader submitted, and it freezes like any other.
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

  arriving := OLD.sync_state <> 'SYNCED' AND OLD.uploaded_at IS NULL
          AND NEW.sync_state = 'SYNCED' AND NEW.uploaded_at IS NOT NULL;

  FOR changed_column IN
    SELECT key
    FROM jsonb_each(to_jsonb(OLD)) AS o(key, value)
    WHERE o.value IS DISTINCT FROM (to_jsonb(NEW) -> o.key)
  LOOP
    IF changed_column = 'updated_at' THEN
      CONTINUE;
    END IF;

    IF arriving AND changed_column = ANY (arrival_columns) THEN
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
