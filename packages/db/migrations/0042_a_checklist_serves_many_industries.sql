-- =============================================================================
-- 0042 — A checklist serves many industries; an import names them
--
-- 0018 gave each checklist template one `industry_id`, NULL meaning "every sector". The
-- product owner settled three things that pointer cannot carry:
--
--   1. **One checklist may serve several industries.** An Office checklist is as true of a
--      hospital's admin block as of a press shop's. Ticking it for Hospital on the
--      Industries screen must not take it away from Engineering.
--   2. **An import names the industries it is for.** A Super Admin uploading a hospital's
--      workbook says so before the preview, and the checklists it makes carry the label.
--   3. **Importing for one industry never changes another's questions.** A hospital
--      workbook with an "Office" sheet makes the hospital its *own* Office checklist; it
--      does not become version n+1 of the engineering one that every plant is auditing
--      against.
--
-- So:
--
--   * `checklist_template_industry` replaces the column — one row per (template, industry)
--     link. A template with no live link is offered to every industry, exactly as a NULL
--     column was. Unticking is `removed_at`, never DELETE (D8): who labelled which
--     checklist for which sector, and when it stopped, is reference-data history worth
--     keeping, and the no-delete trigger makes that a guarantee.
--   * `checklist_template.sheet_code` is the code derived from the sheet name
--     (`Stores (RM)` → `STORES_RM`), no longer required to be unique. The importer
--     matches a sheet to the template with the same `sheet_code` **and the same set of
--     industries**; anything else is a new template. `code` stays unique — it is what
--     logs and screens print — and a new template whose sheet code is taken gets the
--     industry codes appended (`OFFICE_HOSPITAL`).
--   * `checklist_import_job.industry_ids` records what the Super Admin chose, because
--     stage 4's match runs in the worker, long after the request that chose it.
--
-- Still **not** multi-tenancy, and still never an access decision (0018): an industry
-- decides what a screen offers.
-- =============================================================================

CREATE TABLE IF NOT EXISTS checklist_template_industry (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES checklist_template (id) ON DELETE RESTRICT,
  industry_id  uuid NOT NULL REFERENCES industry (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Set when the link is unticked. A later re-tick is a new row, so the history reads
  -- straight through.
  removed_at   timestamptz
);

-- At most one live link per pair; removed rows stay out of the way of a re-tick.
CREATE UNIQUE INDEX IF NOT EXISTS checklist_template_industry_live_key
  ON checklist_template_industry (template_id, industry_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS checklist_template_industry_industry_idx
  ON checklist_template_industry (industry_id) WHERE removed_at IS NULL;

CREATE TRIGGER checklist_template_industry_no_delete BEFORE DELETE ON checklist_template_industry
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

COMMENT ON TABLE checklist_template_industry IS
  'Which industries a checklist template is offered to. No live row means every industry. '
  'Never consulted for authorization.';

-- --- Carry 0018's labels across -------------------------------------------------
--
-- Before RLS is enabled below, for the reason 0018 gives: a migration runs with no actor,
-- so `app_is_super_admin()` is false and the insert policy would refuse these rows.
INSERT INTO checklist_template_industry (template_id, industry_id)
SELECT id, industry_id FROM checklist_template WHERE industry_id IS NOT NULL;

-- The column is gone rather than left beside the table: two places saying which sector a
-- checklist belongs to is two places that can disagree. Its index goes with it.
ALTER TABLE checklist_template DROP COLUMN IF EXISTS industry_id;

-- --- Sheet code -------------------------------------------------------------------
ALTER TABLE checklist_template ADD COLUMN IF NOT EXISTS sheet_code text;
UPDATE checklist_template SET sheet_code = code WHERE sheet_code IS NULL;
ALTER TABLE checklist_template ALTER COLUMN sheet_code SET NOT NULL;

-- A template inserted without one takes its own code, which is what every template was
-- before this migration. The importer always names it; this keeps any other insert — a
-- fixture, a hand-run statement — from failing on a column it has never heard of.
-- BEFORE INSERT runs ahead of the NOT NULL check, so the constraint still holds.
CREATE OR REPLACE FUNCTION checklist_template_default_sheet_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sheet_code IS NULL THEN
    NEW.sheet_code := NEW.code;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER checklist_template_default_sheet_code BEFORE INSERT ON checklist_template
  FOR EACH ROW EXECUTE FUNCTION checklist_template_default_sheet_code();
CREATE INDEX IF NOT EXISTS checklist_template_sheet_code_idx ON checklist_template (sheet_code);

COMMENT ON COLUMN checklist_template.sheet_code IS
  'The code derived from the workbook sheet name. Not unique: the same sheet imported for '
  'different industries makes different templates. The importer matches on this plus the '
  'exact set of industries.';

-- --- What an import was for ---------------------------------------------------------
ALTER TABLE checklist_import_job
  ADD COLUMN IF NOT EXISTS industry_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN checklist_import_job.industry_ids IS
  'The industries the Super Admin chose for this workbook. Empty means every industry.';

-- --- RLS ----------------------------------------------------------------------------
-- Read as broadly as the catalogue it labels (D2); written by a Super Admin, like 0018.
ALTER TABLE checklist_template_industry ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_template_industry FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON checklist_template_industry TO audit5s_app;

CREATE POLICY checklist_template_industry_select ON checklist_template_industry FOR SELECT
  USING (app_actor_id() IS NOT NULL);
CREATE POLICY checklist_template_industry_insert ON checklist_template_industry FOR INSERT
  WITH CHECK (app_is_super_admin());
CREATE POLICY checklist_template_industry_update ON checklist_template_industry FOR UPDATE
  USING (app_is_super_admin());
