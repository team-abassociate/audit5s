-- =============================================================================
-- 0017 — Password reset by email
--
-- `POST /auth/forgot-password` existed and did nothing but write a log line: §12.1 says a
-- password is never sent in plaintext, and the one-time link it described had nowhere to
-- live. This is that somewhere.
--
-- Email, not SMS. Delivering an OTP to an Indian mobile number needs the sender and the
-- template registered with a telecom operator under TRAI's DLT rules, which takes days and
-- company paperwork. Email needs an SMTP account. The OTP endpoints in `auth.controller`
-- stay exactly as they are — they are a login path, not a reset path, and nothing here
-- touches them.
--
-- The token is stored as a SHA-256 hash, like every other token in this schema. A reset
-- table readable by anyone who can read the database would be a password reset table that
-- hands out password resets.
-- =============================================================================

CREATE TABLE IF NOT EXISTS password_reset_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  -- Single use. Set the moment the token is spent, and checked before the password is.
  consumed_at timestamptz,
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER password_reset_token_set_updated_at BEFORE UPDATE ON password_reset_token
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The lookup is by hash: the raw token arrives from the link and is hashed to find its row.
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_token_hash_key
  ON password_reset_token (token_hash);

-- "Is there already a live token for this user?" — so a second request within the window
-- can supersede the first rather than leaving two valid links in two inboxes.
CREATE INDEX IF NOT EXISTS password_reset_token_user_live_idx
  ON password_reset_token (user_id, expires_at)
  WHERE consumed_at IS NULL;

-- --- RLS ---------------------------------------------------------------------
--
-- Nobody reaches this table through a request scope. Every path that touches it is
-- unauthenticated by definition — the whole point is that the user cannot log in — so the
-- service reads and writes it as the owner role, exactly as `otp_challenge` is handled,
-- and no policy admits the application role to it at all.
ALTER TABLE password_reset_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_token FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON password_reset_token TO audit5s_app;

-- The application role may act on this table only through the definer functions below;
-- the policies deliberately admit nothing, so a direct query returns no rows.
CREATE POLICY password_reset_token_none ON password_reset_token FOR SELECT USING (false);

-- -----------------------------------------------------------------------------
-- Issue: supersede any live token for the user, then mint one.
--
-- Superseding matters. Without it, asking twice leaves two working links, and the older
-- one is the one more likely to have been intercepted — a forwarded mail, a shared
-- machine, a mailing list that keeps a copy.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_issue_password_reset(
  p_user_id    uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_ip         text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE password_reset_token
     SET consumed_at = now()
   WHERE user_id = p_user_id AND consumed_at IS NULL;

  INSERT INTO password_reset_token (user_id, token_hash, expires_at, ip_address)
  VALUES (p_user_id, p_token_hash, p_expires_at, p_ip)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Redeem: spend the token and return whose it was, or NULL.
--
-- One statement, so a token cannot be spent twice by two requests arriving together. The
-- `consumed_at IS NULL` in the WHERE clause is the lock: the second UPDATE matches no row.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_redeem_password_reset(p_token_hash text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE password_reset_token
     SET consumed_at = now()
   WHERE token_hash = p_token_hash
     AND consumed_at IS NULL
     AND expires_at > now()
  RETURNING user_id;
$$;

REVOKE ALL ON FUNCTION app_issue_password_reset(uuid, text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_redeem_password_reset(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_issue_password_reset(uuid, text, timestamptz, text) TO audit5s_app;
GRANT EXECUTE ON FUNCTION app_redeem_password_reset(text) TO audit5s_app;
