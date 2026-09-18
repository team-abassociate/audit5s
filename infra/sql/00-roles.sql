-- Cluster roles.
--
-- Applied by bootstrap.sh through psql, NOT from /docker-entrypoint-initdb.d. The role
-- passwords are secrets: a file mounted into initdb.d receives no psql variables, so it
-- could only ever create these roles with literals committed to git. Going through psql
-- also makes this idempotent, so it runs on every bootstrap and converges on the
-- passwords currently in .env rather than only on a fresh cluster.
--
-- Required environment variables, forwarded to psql by bootstrap.sh:
--   APP_OWNER_PASSWORD
--   APP_PASSWORD
-- bootstrap.sh refuses to run when either is unset, so this file does not re-check.
--
-- Two roles, deliberately:
--   audit5s_owner — owns the schema and runs migrations and the seed.
--   audit5s_app   — what the API, worker-general and worker-report connect as. It is NOT
--                   the owner, so it does not bypass row-level security, and it holds no
--                   UPDATE/DELETE grant on the append-only tables (AL-1).

\set ON_ERROR_STOP on
\getenv owner_password APP_OWNER_PASSWORD
\getenv app_password APP_PASSWORD

-- format(%L) quotes the value as a literal, so a password containing a quote is escaped
-- rather than ending the statement early.
SELECT format('CREATE ROLE audit5s_owner LOGIN PASSWORD %L', :'owner_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit5s_owner')
\gexec

SELECT format('CREATE ROLE audit5s_app LOGIN PASSWORD %L', :'app_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit5s_app')
\gexec

-- A re-run must adopt the passwords in .env, not leave whatever the roles were first
-- created with. This is also the rotation path: change .env, re-run bootstrap.
SELECT format('ALTER ROLE audit5s_owner PASSWORD %L', :'owner_password')
\gexec

SELECT format('ALTER ROLE audit5s_app PASSWORD %L', :'app_password')
\gexec

-- The app role must never acquire ownership implicitly, and must never bypass RLS.
ALTER ROLE audit5s_app NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE audit5s_owner NOBYPASSRLS NOSUPERUSER;

-- The owner must be a member of the application role to create objects owned by it
-- (migration 0002 hands pg-boss its own schema this way).
GRANT audit5s_app TO audit5s_owner;

-- The owner must own the database itself: since PostgreSQL 15 only the database owner may
-- create in `public`, and migration 0002 grants CREATE ON DATABASE, which needs the owner.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO audit5s_owner', current_database());
END
$$;
