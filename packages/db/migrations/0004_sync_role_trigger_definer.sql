-- =============================================================================
-- 0004_sync_role_trigger_definer
--
-- `unit_membership_sync_role()` reads `"user"` to confirm the denormalised role matches the
-- user's own. As written in 0001 it ran with the invoker's privileges, so row-level
-- security applied to that read — and a Coordinator inserting the membership for a Zone
-- Leader they have just created cannot see that user yet: the very membership that brings
-- them into scope is the row being inserted.
--
-- The trigger then reported "references a user that does not exist" about a row the
-- foreign key had already proved exists. That is an integrity check being defeated by a
-- visibility rule, which is not what RLS is for.
--
-- SECURITY DEFINER with a fixed search_path fixes it. The function reads exactly one
-- column of one row addressed by primary key and returns nothing to the caller, so it
-- leaks nothing: the only observable effect is that a wrong `role` is corrected.
-- =============================================================================

CREATE OR REPLACE FUNCTION unit_membership_sync_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actual_role role;
BEGIN
  SELECT u.role INTO actual_role FROM "user" u WHERE u.id = NEW.user_id;
  IF actual_role IS NULL THEN
    RAISE EXCEPTION 'unit_membership references a user that does not exist';
  END IF;
  IF NEW.role IS DISTINCT FROM actual_role THEN
    NEW.role := actual_role;
  END IF;
  RETURN NEW;
END;
$$;
