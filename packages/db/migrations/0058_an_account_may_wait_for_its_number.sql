-- =============================================================================
-- 0058 — An account may wait for its mobile number (DECISIONS.md R-65)
--
-- Owner, 2026-10-27: a name on the Auditor list without a mobile number still gets its
-- account; the Coordinator adds the number later in People. The number is the account's
-- first password and the end of its login ID (CH-1, §12.2), so until it is added the
-- account has neither: it cannot sign in. Adding the number allocates the login ID as
-- any account's is ("OM0201") and issues the bootstrap credential.
--
-- The three are set together or not at all, so nothing can half-make a login. A login ID,
-- once allocated, is still never changed or reused.
-- =============================================================================

ALTER TABLE "user" ALTER COLUMN login_id DROP NOT NULL;
ALTER TABLE "user" ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE "user" ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE "user" ADD CONSTRAINT user_login_complete CHECK (
  (login_id IS NULL) = (phone_e164 IS NULL) AND (login_id IS NULL) = (password_hash IS NULL)
);
