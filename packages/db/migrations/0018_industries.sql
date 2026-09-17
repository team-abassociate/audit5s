-- =============================================================================
-- 0018 — Industries
--
-- The product was built for one sector. Every checklist template in the catalogue is an
-- engineering department — Stores (RM), Press Shop, Tool Room — and nothing in the schema
-- said so, because when there is only one of a thing it does not need a name.
--
-- Selling the same product to a hospital means a second catalogue that must not appear in
-- an engineering plant's audit, and vice versa. That is the whole of this change: a name
-- for the sector, a pointer from each template, and a pointer from each Unit.
--
-- **This is not multi-tenancy.** One organization, one set of users, one authorization
-- model — `STACK.md` §8 flags multi-org as touching every scope predicate, and nothing
-- here touches one. An industry is a *label on reference data*, in the same family as
-- `checklist_template.sort_order`: it decides what a screen offers, never what a person
-- may see. Any future code that reads `industry_id` to decide access is reading it wrong.
--
-- Both pointers are nullable, and deliberately so:
--   * A template with no industry is offered everywhere. That is what every existing row
--     becomes at the bottom of this file but one, and it is the honest default for a
--     checklist nobody has classified yet.
--   * A Unit with no industry is offered everything, which is exactly today's behaviour.
-- Making either NOT NULL would mean inventing an answer for rows that predate the
-- question.
-- =============================================================================

CREATE TABLE IF NOT EXISTS industry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable and shouted, like every other code in this schema: ENGINEERING, HOSPITAL.
  code        text NOT NULL,
  name        text NOT NULL,
  description text,
  sort_order  integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER industry_set_updated_at BEFORE UPDATE ON industry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Archived rows keep their code out of the way of a new one reusing it, exactly as
-- `user_email_active_key` does.
CREATE UNIQUE INDEX IF NOT EXISTS industry_code_active_key
  ON industry (code) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS industry_sort_idx ON industry (sort_order, name);

-- An industry is never deleted: templates and Units point at it, and a catalogue that can
-- lose its sector label is a catalogue nobody can explain later. Archiving is the exit.
CREATE TRIGGER industry_no_delete BEFORE DELETE ON industry
  FOR EACH ROW EXECUTE FUNCTION enforce_no_delete();

ALTER TABLE checklist_template
  ADD COLUMN IF NOT EXISTS industry_id uuid REFERENCES industry (id) ON DELETE RESTRICT;

ALTER TABLE unit
  ADD COLUMN IF NOT EXISTS industry_id uuid REFERENCES industry (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS checklist_template_industry_idx
  ON checklist_template (industry_id, sort_order);
CREATE INDEX IF NOT EXISTS unit_industry_idx ON unit (industry_id);

COMMENT ON COLUMN checklist_template.industry_id IS
  'Which sector this template belongs to. NULL means every sector — the default for a '
  'template nobody has classified. Never consulted for authorization.';
COMMENT ON COLUMN unit.industry_id IS
  'Which sector this Unit operates in, narrowing the checklists its audits offer. NULL '
  'means no narrowing. Never consulted for authorization.';

-- --- RLS ---------------------------------------------------------------------
--
-- Read is deliberately broad, exactly as `checklist_template_select` is (D2): the list of
-- sectors carries no Unit-identifying data, every field client caches it offline, and a
-- Consultant has to see the label on the catalogue they are already allowed to read.
-- Writing is a Super Admin's, like every other piece of organization-wide reference data.
ALTER TABLE industry ENABLE ROW LEVEL SECURITY;
ALTER TABLE industry FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON industry TO audit5s_app;

CREATE POLICY industry_select ON industry FOR SELECT
  USING (app_actor_id() IS NOT NULL);
CREATE POLICY industry_insert ON industry FOR INSERT
  WITH CHECK (app_is_super_admin());
CREATE POLICY industry_update ON industry FOR UPDATE
  USING (app_is_super_admin());

-- --- The sector this product already sells to ---------------------------------
--
-- Named here rather than left to a seed script: every template in the catalogue today is
-- an engineering department, and a deployment that migrates without this would show an
-- empty industry list beside a catalogue that plainly belongs to one.
--
-- Existing templates are tagged with it. That is a statement of fact about the rows that
-- exist, not a default for rows that do not — a template imported tomorrow is untagged
-- until somebody says otherwise, and is therefore offered everywhere.
INSERT INTO industry (code, name, description, sort_order)
VALUES (
  'ENGINEERING',
  'Engineering',
  'Manufacturing and engineering plants — the sector this product was first built for.',
  10
)
ON CONFLICT DO NOTHING;

UPDATE checklist_template
   SET industry_id = (SELECT id FROM industry WHERE code = 'ENGINEERING')
 WHERE industry_id IS NULL;
