# Supabase experiment (DB-only) — branch `feature/supabase-migration`

## Scope

This branch swaps the **self-hosted PostgreSQL container for Supabase's managed
PostgreSQL**. Nothing else changes:

- Auth stays the app's own custom JWT system (not Supabase Auth).
- Object storage stays Cloudflare R2 (not Supabase Storage).
- pg-boss, Drizzle, RLS policies, and the domain code are all unchanged — they
  just point at a different Postgres.

This is a test branch. `main` (and the separate `project-oracle-original` checkout) are
untouched.

## Important: connection pooling mode

Use Supabase's **Session pooler** or the **direct connection** (port `5432`) —
**not** the **Transaction pooler** (port `6543`).

Two things in this codebase need session-scoped Postgres state that pgbouncer's
transaction mode does not preserve across statements in the same logical transaction:

- `packages/db/src/client.ts` — `withActor()` sets `app.actor_id` / `app.actor_role`
  via `SET LOCAL` for RLS to read.
- `apps/api/src/infrastructure/queue/queue.service.ts` — pg-boss.

## What changed in code

1. **`apps/api/src/config/env.ts`** — added `DATABASE_SSL` (`disable` | `require` |
   `no-verify`), since Supabase requires TLS and the self-hosted setup never configured it.
2. **`apps/api/src/infrastructure/database/database.module.ts`** — the `pg.Pool` now
   passes an `ssl` option derived from `DATABASE_SSL`.
3. **`packages/db/src/migrate.ts`** — same SSL handling for the standalone migration
   `Client`.
4. **`.env.supabase.example`** — a copy of `.env.example` with the `DATABASE_*` block
   pointed at Supabase's connection-string format and pooling guidance inline.
5. **`docker-compose.supabase.yml`** — override that disables the local `postgres` and
   `pgbackrest` services and injects `DATABASE_SSL` into `api` / `worker-general` /
   `worker-report`.

## Steps to actually test it

1. Create a Supabase project (or use an existing one) at supabase.com.
2. Project Settings → Database → Connection string → copy the **Session pooler**
   string (port 5432).
3. `cp .env.supabase.example .env` and fill in `DATABASE_URL` /
   `DATABASE_MIGRATION_URL` with that string (both can point at the same Supabase
   role for this test), plus the other required vars (JWT keys etc. — same as any
   normal local setup, see `.env.example`).
4. Run migrations against Supabase:
   ```
   pnpm db:migrate
   ```
5. Bring up the app pointed at Supabase, keeping MinIO for storage:
   ```
   docker compose -f docker-compose.yml -f docker-compose.dev.yml \
     -f docker-compose.supabase.yml up -d api worker-general worker-report minio
   ```
6. Smoke-test: `curl http://localhost:3000/api/v1/health`, log in, run through a
   basic audit flow.

## Known things worth checking once it's actually running

- **RLS policies** were written for self-hosted Postgres with a custom `app.actor_id`
  GUC. Supabase's own `auth.uid()` / built-in RLS helpers are irrelevant here since this
  app isn't using Supabase Auth — but worth confirming Supabase doesn't impose any
  extra default RLS or `search_path` restrictions on the `postgres` role that the
  migration/owner role relies on.
- **Extensions** (`pgcrypto`, `pg_trgm`, `uuid-ossp`) are all available on Supabase but
  confirm they're enabled on the project (Database → Extensions) before migrating —
  migration `0001_foundation.sql` likely `CREATE EXTENSION`s them, so this may be
  automatic; verify against the actual migration output.
- **pg-boss behavior under Supabase's pooler** — worth an explicit test (enqueue a job,
  confirm a worker picks it up) since this is the part most likely to behave
  differently from a direct self-hosted connection.
- **Latency**: Supabase project region vs. where you're running the app affects perceived
  performance during testing; not a correctness issue, just don't over-interpret timing.

## Rolling back

This entire experiment lives on `feature/supabase-migration` in this separate checkout
(`project-supabase-migration/`). To discard it: delete this checkout, or `git checkout
main` and delete the branch. `main` was never touched, and the original
`project-oracle-original/` checkout is a completely separate clone that was never
modified at all.
