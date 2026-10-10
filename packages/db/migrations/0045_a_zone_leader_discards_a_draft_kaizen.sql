-- =============================================================================
-- 0045 — A Zone Leader discards their own draft Kaizen
--
-- Owner, 2026-10-10 (DECISIONS.md R-49). Additive only: one nullable column, one trigger,
-- and 0044's photo trigger taught the new column. The release before this one runs
-- unchanged on it: nothing it writes sets `discarded_at`.
--
-- Nothing is hard-deleted (D8). A discarded draft keeps its row, its number and its
-- photos; `discarded_at` takes it out of every list. Only a DRAFT may be discarded, and a
-- discarded row never changes again.
-- =============================================================================

ALTER TABLE kaizen ADD COLUMN discarded_at timestamptz;

CREATE OR REPLACE FUNCTION enforce_kaizen_discard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Kaizen % was discarded: it does not change again', OLD.kaizen_no
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.discarded_at IS NOT NULL AND (OLD.status <> 'DRAFT' OR NEW.status <> 'DRAFT') THEN
    RAISE EXCEPTION 'Kaizen % is %: only a draft can be discarded', OLD.kaizen_no, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Fires before `kaizen_set_updated_at` and `kaizen_transition` (triggers run by name).
CREATE TRIGGER kaizen_discard BEFORE UPDATE ON kaizen
  FOR EACH ROW EXECUTE FUNCTION enforce_kaizen_discard();

-- 0044's photo rule, plus: a discarded draft takes no new photo and loses none. A
-- `commit` (uploaded_at) may still land, as it may on a submitted Kaizen: the bytes were
-- already on their way.
CREATE OR REPLACE FUNCTION enforce_kaizen_photo_editable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k record;
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

  SELECT status, discarded_at INTO k FROM kaizen WHERE id = NEW.kaizen_id;
  IF k.status NOT IN ('DRAFT','SENT_BACK') THEN
    RAISE EXCEPTION 'Kaizen photos change only while the Kaizen is a draft or sent back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF k.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Kaizen photos do not change on a discarded draft'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_kaizen_photo_editable() FROM PUBLIC;

COMMENT ON COLUMN kaizen.discarded_at IS
  'When the author discarded this draft (R-49). Set only on a DRAFT; the row then never '
  'changes and is left out of every list, count and export. Never deleted.';
