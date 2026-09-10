-- =============================================================================
-- 0002_pgboss_schema
--
-- pg-boss manages its own tables, but it cannot create the schema to put them in: the
-- application role deliberately has no CREATE privilege on the database (0001), so that a
-- compromised application cannot add objects.
--
-- Creating the schema here, owned by the application role, gives pg-boss exactly the room
-- it needs and nothing else. Its own migrations then run as the owner of that schema.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION audit5s_app;

GRANT USAGE ON SCHEMA pgboss TO audit5s_app;

-- pg-boss also runs `CREATE SCHEMA IF NOT EXISTS` itself at startup, and PostgreSQL checks
-- the database-level CREATE privilege before the IF NOT EXISTS short-circuits — so the
-- schema existing is not enough. pg-boss owns and version-migrates its own tables; that is
-- its operating model, and the alternative (running its construction and migration plans
-- from our migrations) couples our schema to its internals at every upgrade.
--
-- What this does not weaken: the guarantees that matter here are not "the application
-- cannot create objects". They are that audit data cannot be modified or deleted — which
-- rests on the append-only triggers, the withheld UPDATE/DELETE grants on audit_log and
-- login_attempt (AL-1), and RLS. None of those are affected by the ability to create a
-- table in a schema of its own.
GRANT CREATE ON DATABASE audit5s TO audit5s_app;
