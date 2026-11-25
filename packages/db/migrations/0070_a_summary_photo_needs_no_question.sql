-- =============================================================================
-- 0070 — A Zone's summary photo may be added on its own, linked to no question (R-91)
--
-- Owner, 2026-11-25: at the end of an audit, the auditor taps the Good or the Nonconformity
-- summary slot and adds a photograph there — taken live or from the gallery, with a remark —
-- without going back to a question. It prints in the Zone report and the summary report.
--
-- `SUMMARY_PHOTO` is that photograph. The existing constraints already hold it to a Zone
-- (`evidence_zone_link`) and to no question (`evidence_question_link`). This file
-- adds the one rule of its own: it is GOOD or NONCONFORMITY, never NEUTRAL, because the slot
-- it was added to is its classification. It raises no corrective action (owner, same day):
-- `materialize` reads only question and walk-by photographs, and that is unchanged.
-- =============================================================================

-- Not used as an enum literal in this transaction, so ADD VALUE may run inside it.
ALTER TYPE evidence_kind ADD VALUE IF NOT EXISTS 'SUMMARY_PHOTO';

-- Compared as text: the new label cannot be read as an enum value until this commits.
ALTER TABLE evidence ADD CONSTRAINT evidence_summary_photo_judged CHECK (
  kind::text <> 'SUMMARY_PHOTO' OR classification IN ('GOOD','NONCONFORMITY')
);
