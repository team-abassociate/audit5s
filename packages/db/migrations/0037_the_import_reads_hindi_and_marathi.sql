-- =============================================================================
-- 0037 — The checklist import reads Hindi and Marathi
--
-- A department sheet may carry `Check Point (Hindi)` and `Check Point (Marathi)`
-- columns. What the parser read from them is kept on the import row between PREVIEW
-- and COMMIT, exactly as the English is: stage 6 commits what the Super Admin
-- previewed, never a second read of a file that could have changed in between.
--
-- `{}` when the sheet has no translation columns, which is every import before this one.
-- The translations themselves land in `checklist_question_translation` (0036) at commit;
-- this column is working data, and goes when the job's rows do.
-- =============================================================================

ALTER TABLE checklist_import_row
  ADD COLUMN parsed_translations jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN checklist_import_row.parsed_translations IS
  'Hindi / Marathi wording read from the sheet''s translation columns, {"hi": …, "mr": …}. Empty when there were none.';
