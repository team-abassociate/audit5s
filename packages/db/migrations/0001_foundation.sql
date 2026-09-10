-- =============================================================================
-- 0001_foundation
--
-- Phase 1 schema: identity, access and the audit trail (ARCHITECTURE.md PART 14).
-- Tables: user, unit, unit_membership, permission, role_permission, refresh_token,
--         revoked_access_token, login_attempt, otp_challenge, device, audit_log,
--         idempotency_key.
--
-- Deliberately absent:
--   * `domain_event` — DECISIONS.md R-2 removes the transactional outbox. pg-boss stores
--     its jobs in this same database, so a second outbox table would be a duplicate
--     mechanism doing one job.
--   * `zone` and everything downstream — Phase 2 onward.
--
-- This migration runs as the owner role. The application connects as `audit5s_app`,
-- which is deliberately NOT the owner: it is denied UPDATE/DELETE on append-only tables
-- (AL-1) and, not being the owner, does not bypass row-level security.
-- =============================================================================

-- Extensions: exactly the three STACK.md §2 permits. No others without a decision.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -----------------------------------------------------------------------------
-- Enums (ARCHITECTURE.md §5.1). Only those the Phase 1 tables reference; later
-- phases add their own alongside the tables that use them.
-- -----------------------------------------------------------------------------
CREATE TYPE role              AS ENUM ('SUPER_ADMIN','CONSULTANT','COORDINATOR','ZONE_LEADER');
CREATE TYPE user_status       AS ENUM ('INVITED','ACTIVE','DISABLED','LOCKED');
CREATE TYPE membership_status AS ENUM ('ACTIVE','REVOKED');

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

-- `updated_at` is maintained by the database, not by application discipline.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Append-only enforcement (STACK.md §5, D8). "Nothing is hard-deleted" is a database
-- guarantee, not a convention: these triggers raise rather than the application
-- remembering not to issue the statement.
--
-- The function takes the updatable-column carve-out as trigger arguments. DECISIONS.md
-- R-5 requires that when the `evidence` trigger is first written it already permits an
-- update touching only `redacted_at`, `redacted_by_user_id` and `redaction_reason` —
-- erasure is redaction, never deletion. Parameterising the function here means that
-- carve-out is structural: the Phase 5 migration that creates `evidence` passes those
-- three column names when it attaches the trigger, and there is never a moment where a
-- carve-out-less trigger is live over real audit data and has to be altered.
CREATE OR REPLACE FUNCTION enforce_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed_columns text[] := COALESCE(TG_ARGV, ARRAY[]::text[]);
  changed_column  text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Table % is append-only: DELETE is not permitted', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF array_length(allowed_columns, 1) IS NULL THEN
      RAISE EXCEPTION
        'Table % is append-only: UPDATE is not permitted', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Any column that actually changed and is not in the carve-out fails the statement.
    FOR changed_column IN
      SELECT key
      FROM jsonb_each(to_jsonb(OLD)) AS o(key, value)
      WHERE o.value IS DISTINCT FROM (to_jsonb(NEW) -> o.key)
    LOOP
      IF NOT (changed_column = ANY (allowed_columns)) THEN
        RAISE EXCEPTION
          'Table % is append-only: column % may not be updated', TG_TABLE_NAME, changed_column
          USING ERRCODE = 'restrict_violation';
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Request-scoped actor context, read by every RLS policy.
--
-- The API sets these with SET LOCAL inside the request transaction. When nothing is set
-- the accessors return NULL and every business policy denies — the fail-safe default is
-- "no rows", not "all rows".
--
-- RLS here is defence-in-depth behind the application ScopeGuard (STACK.md §5), never
-- the only line: the canonical check is the scope predicate in the repository layer.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_actor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_actor_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor_role', true), '');
$$;

CREATE OR REPLACE FUNCTION app_is_super_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_actor_role() = 'SUPER_ADMIN';
$$;

-- The pre-authentication window. `/auth/login` must read a user row before any actor
-- exists, so the auth repository opts in explicitly with SET LOCAL app.auth_phase='on'.
-- It unlocks the authentication tables only; every business policy still requires a
-- real actor, so a code path that simply forgets to set the context sees nothing.
CREATE OR REPLACE FUNCTION app_in_auth_phase() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.auth_phase', true), '') = 'on';
$$;

-- =============================================================================
-- Identity and access
-- =============================================================================

CREATE TABLE "user" (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id              text        NOT NULL,
  full_name             text        NOT NULL,
  phone_e164            text        NOT NULL,
  email                 text        NULL,
  role                  role        NOT NULL,
  -- Argon2id. Never null, never plaintext, never returned by an API.
  password_hash         text        NOT NULL,
  -- Recorded so a parameter change can be migrated by rehash-on-login.
  password_algo         text        NOT NULL DEFAULT 'argon2id',
  -- CH-1: the phone number is a bootstrap credential only.
  must_reset_password   boolean     NOT NULL DEFAULT true,
  bootstrap_expires_at  timestamptz NULL,
  status                user_status NOT NULL DEFAULT 'INVITED',
  failed_login_count    integer     NOT NULL DEFAULT 0,
  locked_until          timestamptz NULL,
  last_login_at         timestamptz NULL,
  created_by_user_id    uuid        NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  archived_at           timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Archived users keep their login ID reserved forever, so a new employee never inherits
-- an old identity (§12.2). Hence a plain unique, not a partial one.
CREATE UNIQUE INDEX user_login_id_key ON "user" (login_id);
CREATE UNIQUE INDEX user_phone_active_key ON "user" (phone_e164) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX user_email_active_key ON "user" (lower(email))
  WHERE email IS NOT NULL AND archived_at IS NULL;
CREATE INDEX user_role_status_idx ON "user" (role, status);
CREATE INDEX user_full_name_trgm_idx ON "user" USING gin (full_name gin_trgm_ops);

CREATE TRIGGER user_set_updated_at BEFORE UPDATE ON "user"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE unit (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Immutable after creation: object-storage keys embed it (§12.5).
  code               text          NOT NULL,
  name               text          NOT NULL,
  address            text          NULL,
  city               text          NULL,
  state              text          NULL,
  country            text          NULL,
  postal_code        text          NULL,
  contact_name       text          NULL,
  contact_phone      text          NULL,
  contact_email      text          NULL,
  latitude           numeric(9,6)  NULL,
  longitude          numeric(9,6)  NULL,
  -- NULL disables geofencing for the Unit.
  geofence_radius_m  integer       NULL DEFAULT 300,
  timezone           text          NOT NULL DEFAULT 'Asia/Kolkata',
  -- CH-5 soft cap on photos per Zone.
  photo_cap_per_zone integer       NOT NULL DEFAULT 30,
  version            integer       NOT NULL DEFAULT 1,
  archived_at        timestamptz   NULL,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX unit_code_key ON unit (code);
CREATE INDEX unit_archived_at_idx ON unit (archived_at);

CREATE TRIGGER unit_set_updated_at BEFORE UPDATE ON unit
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The single most security-critical table in the system: every scope predicate in
-- PART 6 resolves through it. Rows are never deleted — revoking sets status and
-- valid_to, so history stays explainable.
CREATE TABLE unit_membership (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid              NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  unit_id              uuid              NOT NULL REFERENCES unit(id)   ON DELETE RESTRICT,
  -- Denormalised from the user for fast predicates; kept consistent by trigger below.
  role                 role              NOT NULL,
  status               membership_status NOT NULL DEFAULT 'ACTIVE',
  valid_from           timestamptz       NOT NULL DEFAULT now(),
  valid_to             timestamptz       NULL,
  assigned_by_user_id  uuid              NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  created_at           timestamptz       NOT NULL DEFAULT now(),
  updated_at           timestamptz       NOT NULL DEFAULT now()
);

-- One active membership per (user, unit).
CREATE UNIQUE INDEX unit_membership_active_pair_key
  ON unit_membership (user_id, unit_id) WHERE status = 'ACTIVE';

-- Invariant M-1, migrated rather than merely documented (DECISIONS.md R-3a).
-- A COORDINATOR or ZONE_LEADER may hold at most one ACTIVE membership, which is what
-- makes the `own_unit` resolver's LIMIT 1 deterministic. A CONSULTANT may hold many.
CREATE UNIQUE INDEX unit_membership_one_active_admin
  ON unit_membership (user_id)
  WHERE status = 'ACTIVE' AND role IN ('COORDINATOR','ZONE_LEADER');

CREATE INDEX unit_membership_unit_role_status_idx ON unit_membership (unit_id, role, status);
-- "Which Units may this user touch" — the hot path on every request.
CREATE INDEX unit_membership_user_status_idx ON unit_membership (user_id, status);

CREATE TRIGGER unit_membership_set_updated_at BEFORE UPDATE ON unit_membership
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The denormalised role must agree with the user's own, or every predicate built on it
-- is wrong. Enforced here rather than trusted to the caller.
CREATE OR REPLACE FUNCTION unit_membership_sync_role() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER unit_membership_sync_role_trg
  BEFORE INSERT OR UPDATE OF user_id, role ON unit_membership
  FOR EACH ROW EXECUTE FUNCTION unit_membership_sync_role();

-- Units the current actor holds an ACTIVE membership in. Defined here rather than with
-- the other context helpers because a LANGUAGE sql function is parsed at creation and so
-- must follow the table it reads. SECURITY DEFINER so evaluating it inside the policy on
-- `unit_membership` does not recurse.
CREATE OR REPLACE FUNCTION app_actor_unit_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(m.unit_id), ARRAY[]::uuid[])
  FROM unit_membership m
  WHERE m.user_id = app_actor_id()
    AND m.status = 'ACTIVE'
    AND now() >= m.valid_from
    AND (m.valid_to IS NULL OR now() < m.valid_to);
$$;

-- =============================================================================
-- Permissions — seed data generated from PART 6 by apps/api/src/seed.ts.
-- A test asserts the seeded rows and the matrix in packages/domain agree, so the
-- document, the seed and the runtime cannot drift (§12.4).
-- =============================================================================

CREATE TABLE permission (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource    text NOT NULL,
  action      text NOT NULL,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX permission_resource_action_key ON permission (resource, action);

CREATE TRIGGER permission_set_updated_at BEFORE UPDATE ON permission
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE role_permission (
  role          role NOT NULL,
  permission_id uuid NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
  -- Names the resolver that produces the SQL predicate: organization, own_unit,
  -- assigned_units, own_audits, own_record, assigned_actions, signed_token.
  scope_rule    text NOT NULL,
  -- The prose constraint from the matrix cell, enforced in the service layer (AZ-5).
  condition     text NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, permission_id)
);

CREATE INDEX role_permission_role_idx ON role_permission (role);

CREATE TRIGGER role_permission_set_updated_at BEFORE UPDATE ON role_permission
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- Sessions, devices and the authentication surface
-- =============================================================================

CREATE TABLE device (
  -- Client-generated and stable per install, so a reinstall is a new device.
  id           uuid PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  platform     text        NOT NULL CHECK (platform IN ('android','ios')),
  model        text        NULL,
  os_version   text        NULL,
  app_version  text        NULL,
  push_token   text        NULL,
  last_seen_at timestamptz NULL,
  last_sync_at timestamptz NULL,
  revoked_at   timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_user_revoked_idx ON device (user_id, revoked_at);

CREATE TRIGGER device_set_updated_at BEFORE UPDATE ON device
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE refresh_token (
  -- = JTI.
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  device_id       uuid        NULL REFERENCES device(id) ON DELETE RESTRICT,
  -- SHA-256 of the token. The token itself is never stored.
  token_hash      text        NOT NULL,
  -- Rotation family, for reuse detection (invariant R-1).
  family_id       uuid        NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz NULL,
  revoked_at      timestamptz NULL,
  replaced_by_id  uuid        NULL REFERENCES refresh_token(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refresh_token_hash_key ON refresh_token (token_hash);
CREATE INDEX refresh_token_user_revoked_idx ON refresh_token (user_id, revoked_at);
CREATE INDEX refresh_token_family_idx ON refresh_token (family_id);
CREATE INDEX refresh_token_expires_idx ON refresh_token (expires_at);

CREATE TRIGGER refresh_token_set_updated_at BEFORE UPDATE ON refresh_token
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Access-token denylist (§12.3). ARCHITECTURE.md named Redis for this; STACK.md §6
-- forbids Redis, so it lives here — the row count is bounded by the 15-minute access
-- token lifetime and a sweep, which is well within what Postgres does comfortably.
CREATE TABLE revoked_access_token (
  jti        uuid PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  -- The token's own exp: rows are swept once past it, since the token is dead anyway.
  expires_at timestamptz NOT NULL,
  reason     text        NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX revoked_access_token_expires_idx ON revoked_access_token (expires_at);
CREATE INDEX revoked_access_token_user_idx ON revoked_access_token (user_id);

-- Rate limiting and lockout (§12.11): 5 attempts / 15 min per login ID, 20 / 15 min per
-- IP, progressive lockout from 10. Append-only — an attacker's own failures are evidence.
CREATE TABLE login_attempt (
  id          bigserial PRIMARY KEY,
  -- Text, not a FK: attempts against a login ID that does not exist are the interesting
  -- ones, and must be recorded without leaking whether the account exists.
  login_id    text        NOT NULL,
  user_id     uuid        NULL REFERENCES "user"(id) ON DELETE SET NULL,
  ip_address  inet        NULL,
  user_agent  text        NULL,
  device_id   uuid        NULL,
  succeeded   boolean     NOT NULL,
  failure_code text       NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_attempt_login_id_idx ON login_attempt (login_id, occurred_at DESC);
CREATE INDEX login_attempt_ip_idx ON login_attempt (ip_address, occurred_at DESC);
CREATE INDEX login_attempt_occurred_idx ON login_attempt (occurred_at);

CREATE TRIGGER login_attempt_append_only
  BEFORE UPDATE OR DELETE ON login_attempt
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

-- OTP scaffold (§8.3). Codes are hashed, 5-minute TTL, 5 attempts, 3 requests / 10 min.
CREATE TABLE otp_challenge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164    text        NOT NULL,
  -- SHA-256 of the code. The code itself is never stored, exactly as for refresh tokens.
  code_hash     text        NOT NULL,
  expires_at    timestamptz NOT NULL,
  attempt_count integer     NOT NULL DEFAULT 0,
  consumed_at   timestamptz NULL,
  ip_address    inet        NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX otp_challenge_phone_idx ON otp_challenge (phone_e164, created_at DESC);
CREATE INDEX otp_challenge_expires_idx ON otp_challenge (expires_at);

CREATE TRIGGER otp_challenge_set_updated_at BEFORE UPDATE ON otp_challenge
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- Idempotency (§8.2)
--
-- Postgres-only, 48 hours. ARCHITECTURE.md described a Redis fast path in front of this
-- table; STACK.md §6 forbids Redis, and at ~200 jobs/day the fast path buys nothing.
-- =============================================================================

CREATE TABLE idempotency_key (
  key             text        PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  endpoint        text        NOT NULL,
  -- Same key with a different body is a client bug: 422 IDEMPOTENCY_KEY_REUSE.
  request_hash    text        NOT NULL,
  response_status integer     NULL,
  response_body   jsonb       NULL,
  -- Set while the first request is still in flight, so a concurrent retry waits rather
  -- than executing the operation twice.
  completed_at    timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '48 hours'
);

CREATE INDEX idempotency_key_expires_idx ON idempotency_key (expires_at);
CREATE INDEX idempotency_key_user_idx ON idempotency_key (user_id);

-- =============================================================================
-- Audit log (§5.9)
--
-- Invariant AL-1: insert-only. Enforced twice — the application role holds no UPDATE or
-- DELETE grant, and the trigger raises even if a grant is ever mistakenly issued.
-- =============================================================================

CREATE TABLE audit_log (
  -- Sequential by design: this table is append-only and never exposed by ID.
  id            bigserial PRIMARY KEY,
  actor_user_id uuid        NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  actor_role    role        NULL,
  -- Snapshotted, e.g. "Rahul Sharma (RA3210)" — a later rename must not obscure history.
  actor_label   text        NOT NULL,
  action        text        NOT NULL,
  resource_type text        NOT NULL,
  resource_id   uuid        NULL,
  unit_id       uuid        NULL REFERENCES unit(id) ON DELETE RESTRICT,
  -- Diffs with sensitive fields redacted: never a password hash, never a token (§12.12).
  before        jsonb       NULL,
  after         jsonb       NULL,
  ip_address    inet        NULL,
  user_agent    text        NULL,
  device_id     uuid        NULL,
  request_id    text        NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_resource_idx ON audit_log (resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, occurred_at DESC);
CREATE INDEX audit_log_unit_idx ON audit_log (unit_id, occurred_at DESC);

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

-- =============================================================================
-- Row-level security
--
-- Written from day one, not retrofitted (STACK.md §5). These policies are
-- defence-in-depth *behind* the application guard chain, never the only line: the
-- canonical decision is PART 6's scope resolver in the repository layer. What RLS buys
-- is that a repository bug, a forgotten predicate or an injection cannot read across
-- Units, because the database itself will not return the rows.
--
-- Every business policy requires a real actor. A connection that never set the context
-- sees nothing, so "forgot to set the GUC" fails closed.
-- =============================================================================

ALTER TABLE "user"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit                ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_membership     ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission          ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permission     ENABLE ROW LEVEL SECURITY;
ALTER TABLE device              ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_token       ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_access_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempt       ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_challenge       ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY;

-- --- user --------------------------------------------------------------------
-- SUPER_ADMIN: organization. COORDINATOR: own Unit's members. Everyone else: self.
CREATE POLICY user_select ON "user" FOR SELECT
  USING (
    app_in_auth_phase()
    OR app_is_super_admin()
    OR id = app_actor_id()
    OR (
      app_actor_role() = 'COORDINATOR'
      AND EXISTS (
        SELECT 1 FROM unit_membership m
        WHERE m.user_id = "user".id
          AND m.status = 'ACTIVE'
          AND m.unit_id = ANY (app_actor_unit_ids())
      )
    )
  );

CREATE POLICY user_insert ON "user" FOR INSERT
  WITH CHECK (app_is_super_admin() OR app_actor_role() = 'COORDINATOR');

CREATE POLICY user_update ON "user" FOR UPDATE
  USING (
    -- The auth phase updates failed_login_count, locked_until and last_login_at.
    app_in_auth_phase()
    OR app_is_super_admin()
    OR id = app_actor_id()
    OR (
      app_actor_role() = 'COORDINATOR'
      AND EXISTS (
        SELECT 1 FROM unit_membership m
        WHERE m.user_id = "user".id
          AND m.status = 'ACTIVE'
          AND m.role = 'ZONE_LEADER'
          AND m.unit_id = ANY (app_actor_unit_ids())
      )
    )
  );

-- --- unit --------------------------------------------------------------------
CREATE POLICY unit_select ON unit FOR SELECT
  USING (app_is_super_admin() OR id = ANY (app_actor_unit_ids()));

CREATE POLICY unit_insert ON unit FOR INSERT WITH CHECK (app_is_super_admin());

CREATE POLICY unit_update ON unit FOR UPDATE
  USING (
    app_is_super_admin()
    OR (app_actor_role() = 'COORDINATOR' AND id = ANY (app_actor_unit_ids()))
  );

-- --- unit_membership ---------------------------------------------------------
CREATE POLICY unit_membership_select ON unit_membership FOR SELECT
  USING (
    app_is_super_admin()
    OR user_id = app_actor_id()
    OR unit_id = ANY (app_actor_unit_ids())
  );

-- Only a Super Admin assigns or revokes (PART 6.3).
CREATE POLICY unit_membership_insert ON unit_membership FOR INSERT
  WITH CHECK (app_is_super_admin());

CREATE POLICY unit_membership_update ON unit_membership FOR UPDATE
  USING (app_is_super_admin());

-- --- permission / role_permission --------------------------------------------
-- Readable by any authenticated actor: the API resolves the caller's own permissions on
-- every request, and PART 6 is a published part of the design, not a secret. Writable by
-- the seed (owner) alone — the app role holds no write grant below.
CREATE POLICY permission_select ON permission FOR SELECT
  USING (app_actor_id() IS NOT NULL OR app_in_auth_phase());

CREATE POLICY role_permission_select ON role_permission FOR SELECT
  USING (app_actor_id() IS NOT NULL OR app_in_auth_phase());

-- --- device ------------------------------------------------------------------
CREATE POLICY device_select ON device FOR SELECT
  USING (app_in_auth_phase() OR app_is_super_admin() OR user_id = app_actor_id());

CREATE POLICY device_insert ON device FOR INSERT
  WITH CHECK (app_in_auth_phase() OR user_id = app_actor_id());

CREATE POLICY device_update ON device FOR UPDATE
  USING (app_in_auth_phase() OR app_is_super_admin() OR user_id = app_actor_id());

-- --- refresh_token / revoked_access_token ------------------------------------
-- Reached almost entirely from the auth phase, before an actor exists.
CREATE POLICY refresh_token_select ON refresh_token FOR SELECT
  USING (app_in_auth_phase() OR app_is_super_admin() OR user_id = app_actor_id());

CREATE POLICY refresh_token_insert ON refresh_token FOR INSERT
  WITH CHECK (app_in_auth_phase() OR user_id = app_actor_id());

CREATE POLICY refresh_token_update ON refresh_token FOR UPDATE
  USING (app_in_auth_phase() OR app_is_super_admin() OR user_id = app_actor_id());

CREATE POLICY revoked_access_token_select ON revoked_access_token FOR SELECT
  USING (app_in_auth_phase() OR app_is_super_admin() OR user_id = app_actor_id());

CREATE POLICY revoked_access_token_insert ON revoked_access_token FOR INSERT
  WITH CHECK (app_in_auth_phase() OR app_is_super_admin() OR user_id = app_actor_id());

-- --- login_attempt -----------------------------------------------------------
-- Written during the auth phase; read by Super Admin for the security view.
CREATE POLICY login_attempt_select ON login_attempt FOR SELECT
  USING (app_in_auth_phase() OR app_is_super_admin());

CREATE POLICY login_attempt_insert ON login_attempt FOR INSERT
  WITH CHECK (app_in_auth_phase() OR app_actor_id() IS NOT NULL);

-- --- otp_challenge -----------------------------------------------------------
CREATE POLICY otp_challenge_all ON otp_challenge FOR ALL
  USING (app_in_auth_phase()) WITH CHECK (app_in_auth_phase());

-- --- idempotency_key ---------------------------------------------------------
-- Scoped to its owner: replaying another user's stored response would be a disclosure.
CREATE POLICY idempotency_key_select ON idempotency_key FOR SELECT
  USING (user_id = app_actor_id());

CREATE POLICY idempotency_key_insert ON idempotency_key FOR INSERT
  WITH CHECK (user_id = app_actor_id());

CREATE POLICY idempotency_key_update ON idempotency_key FOR UPDATE
  USING (user_id = app_actor_id());

-- --- audit_log ---------------------------------------------------------------
-- Readable by Super Admin only (PART 6.3). Insertable by any authenticated actor,
-- because the interceptor writes as the actor whose action it records.
CREATE POLICY audit_log_select ON audit_log FOR SELECT USING (app_is_super_admin());

CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (app_actor_id() IS NOT NULL OR app_in_auth_phase());

-- =============================================================================
-- Grants
--
-- The application role gets exactly what it needs and nothing more. The two append-only
-- tables withhold UPDATE and DELETE at the privilege level (AL-1), so the trigger is a
-- second line rather than the only one.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO audit5s_app;

GRANT SELECT, INSERT, UPDATE ON
  "user", unit, unit_membership, device, refresh_token, otp_challenge, idempotency_key
TO audit5s_app;

GRANT SELECT, INSERT ON revoked_access_token TO audit5s_app;

-- AL-1 and the login_attempt equivalent: insert and read, never modify or remove.
GRANT SELECT, INSERT ON audit_log TO audit5s_app;
GRANT SELECT, INSERT ON login_attempt TO audit5s_app;

-- Reference data. Written by the seed, which runs as the owner.
GRANT SELECT ON permission, role_permission TO audit5s_app;

GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO audit5s_app;
GRANT USAGE, SELECT ON SEQUENCE login_attempt_id_seq TO audit5s_app;

-- Sweeping expired rows is maintenance, not business logic, and is the one place a
-- DELETE is legitimate. These are short-lived operational tables, not audit data.
GRANT DELETE ON refresh_token, revoked_access_token, otp_challenge, idempotency_key
TO audit5s_app;
