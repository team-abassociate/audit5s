-- Cluster roles. Run once as a superuser, before the first migration.
--
-- Two roles, deliberately:
--   audit5s_owner — owns the schema and runs migrations and the seed.
--   audit5s_app   — what the API, worker-general and worker-report connect as. It is NOT
--                   the owner, so it does not bypass row-level security, and it holds no
--                   UPDATE/DELETE grant on the append-only tables (AL-1).
--
-- Passwords come from the secret store; the placeholders below are overridden by
-- bootstrap.sh with :owner_password / :app_password. See infra/README.md.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit5s_owner') THEN
    CREATE ROLE audit5s_owner LOGIN PASSWORD 'audit5s_owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit5s_app') THEN
    CREATE ROLE audit5s_app LOGIN PASSWORD 'audit5s_app';
  END IF;
END
$$;

-- The app role must never acquire ownership implicitly, and must never bypass RLS.
ALTER ROLE audit5s_app NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE audit5s_owner NOBYPASSRLS NOSUPERUSER;

-- The owner must be a member of the application role to create objects owned by it
-- (migration 0002 hands pg-boss its own schema this way).
GRANT audit5s_app TO audit5s_owner;
