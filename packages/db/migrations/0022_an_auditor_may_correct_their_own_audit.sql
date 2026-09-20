-- =============================================================================
-- 0022 — An auditor may correct their own completed audit (DECISIONS.md R-30)
--
-- Settled by the product owner on 2026-09-20: a Consultant who finds a wrong mark in an
-- audit they conducted should be able to correct it themselves, rather than asking a Super
-- Admin to retype it on the web.
--
-- **A-2 is not relaxed.** The invariant is not "only a Super Admin may change a completed
-- audit"; it is "a completed audit changes only through a door that records who changed
-- what, from what, to what, and why". That door is `PATCH /audits/{id}/post-completion`,
-- it requires a justification, and it writes an `audit.changed_after_completion` entry
-- with the before and the after. This migration widens who holds a key to it. Every other
-- write to a completed audit — the ordinary response upsert, a stray UPDATE in psql — is
-- refused exactly as before.
--
-- The carve-out is still *named*, and still transaction-scoped. What changes is the second
-- half of its condition:
--
--   before:  the override setting is on  AND  the actor is a Super Admin
--   after:   the override setting is on  AND  (Super Admin OR the actor conducted the
--                                              audit the same transaction named)
--
-- `app.post_completion_audit_id` is that name. `AuditsRepository.inOverrideTransaction`
-- sets it beside the flag, from an audit id the guard chain has already judged the actor
-- against — `audit:edit_after_completion` resolved through `own_audits`, so a Consultant
-- reaches this line only for an audit they are the auditor of. The database then checks
-- that again for itself rather than believing the application, which is what makes this
-- defence in depth rather than a comment.
--
-- Both settings are `set_config(..., true)` — transaction-local. Nothing can leave the
-- flag on, and a connection returned to the pool carries neither.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_post_completion_override() RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE(current_setting('app.post_completion_override', true), '') = 'on'
     AND (
       app_is_super_admin()
       OR EXISTS (
         SELECT 1
         FROM audit a
         WHERE a.id = NULLIF(current_setting('app.post_completion_audit_id', true), '')::uuid
           AND a.auditor_user_id = app_actor_id()
       )
     );
$fn$;

COMMENT ON FUNCTION app_post_completion_override() IS
  'A-2 carve-out (R-30): on only inside an override transaction, for a Super Admin or the '
  'auditor of the audit that transaction named.';

-- The three triggers that consult it are unchanged and need no replacement: they call it
-- with no arguments, and the widening is entirely inside the body.
--
--   * `enforce_completed_audit_append_only`  (0006, body replaced in 0021) — audit,
--     audit_zone, question_response
--   * `enforce_evidence_append_only`         (0007) — evidence, so quarantined field work
--     can still be applied through the same door (R-10, R-12)
--   * the corrective-action freeze              (0009)
--
-- An auditor correcting their own audit therefore reaches evidence and corrective actions
-- through the override too, which is the right answer: changing a mark from 0 to 2 has to
-- be able to reclassify the photograph filed under it (E-2), and that photograph's
-- corrective action has to follow.
