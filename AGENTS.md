# AGENTS.md — brief for any coding agent working in this repository

This file is the entry point for Claude Code, Codex, and every other CLI agent.
Read it before touching anything. It is short on purpose: it tells you which documents
bind you, which rules you may not break, and how to behave when several agents are
working on this repository at once.

## What this repository is

`audit5s` — a 5S audit platform for industrial facilities in India: an admin web portal,
an offline-first Android field app, and a NestJS/PostgreSQL backend.

**Stage: specification.** There is no application code yet. The repository currently holds
four documents and nothing else. The first code to be written is build step 1 below.

## The documents, and which one wins

Read in this order:

1. **[`STACK.md`](./STACK.md)** — the Stack Decision Record. The operating contract:
   stack table, non-negotiable implementation rules, the "do not add" table, build order.
2. **[`DECISIONS.md`](./DECISIONS.md)** — resolutions R-1 … R-5. Binding.
3. **[`ARCHITECTURE.md`](./ARCHITECTURE.md)** — domain model, authorization matrix, state
   machines, database schema, REST API, sync protocol. 225 KB; read the section you need,
   not the whole file. PART 1 settles the vocabulary and is binding.

**Precedence (R-1): `STACK.md` wins on any technology name. `ARCHITECTURE.md` wins on any
behaviour.** The superseded-technology table at the top of `ARCHITECTURE.md` is the
complete list of names that changed.

Decisions in these documents are settled. Do not re-open one mid-task. If you believe one
is wrong, say so and wait for an answer — do not write code against a different assumption.

## Rules you may not break

These are the ones that are expensive or impossible to retrofit. `STACK.md` §5 is the full
list; this is the subset that most often gets quietly violated.

- **The guard chain is global and composed:** `JwtAuthGuard → PermissionGuard → ScopeGuard`.
  Opting an endpoint out is explicit and must be justified. An unguarded endpoint is a bug.
- **No repository method executes without a scope predicate** (AZ-1, restated in R-1). No
  Drizzle query is constructed outside a repository class.
- **Nothing is hard-deleted.** Append-only tables enforce it with `BEFORE UPDATE` /
  `BEFORE DELETE` triggers. Erasure is redaction (R-5), never deletion.
- **Scoring is server-authoritative.** Client-submitted scores are inputs to recompute,
  never stored as truth. The NA-excluded denominator is implemented once, in
  `packages/domain`, and used by both server and client.
- **Idempotency keys on every mutating endpoint, from the first commit.** Retrofitting this
  into an offline client already in the field means a forced app update.
- **Media never transits the API.** Presigned PUT to upload, short-TTL presigned GET to
  download. No public buckets, ever.
- **Never define a shared type twice.** Anything crossing an app boundary lives in
  `packages/contracts`. If you are copying a type between apps, stop and move it.
- **`timestamptz` everywhere, stored in UTC.**
- **pg-boss is the only enqueue mechanism** (R-2). There is no `domain_event` outbox table.

### Two lists that fail CI or waste your time

- **The "do not add" table** (`STACK.md` §6) — Redis, Kubernetes, Kafka, Turborepo, GraphQL,
  managed auth, SSR, and others. Each has a defined trigger. Absent the trigger, adding it
  is strictly negative. **If a task requires one of these, stop and ask.**
- **The OCI do-not-touch list** (`STACK.md` §6) — a CI grep for `oci-`, `oraclecloud.com`
  and `@oracle/` in `apps/` and `packages/` enforces it. Permitted: a VM, a block volume,
  a VCN with a security list. Nothing else.

## Build order

From `STACK.md` §7. Steps depend on the ones before them — pick work accordingly.

1. `packages/contracts` + `packages/db` — schema, migrations, RLS, append-only triggers.
   The `evidence` redaction carve-out (R-5) and invariant M-1's partial unique index (R-3a)
   ship **here**, in the first migration.
2. `packages/domain` — scoring, state machines. Pure, no IO, 90% coverage.
3. API skeleton — guard chain, scope resolvers, the authorization test suite, `/health`,
   idempotency middleware, and the pg-boss rollback test (R-2). Infrastructure is set up
   alongside this step, not at the end.
4. Auth · 5. Core CRUD · 6. Checklists + Excel import · 7. Mobile shell · 8. Audit capture ·
9. Admin web · 10. Reports · 11. Corrective actions · 12. Notifications.

## Working alongside other agents

Superset runs each agent in its own git worktree, so your checkout is isolated but the
repository is shared. That changes what a good task looks like:

- **One build step, or one slice of one, per workspace.** Steps 1 and 2 are a serialization
  point — almost everything else depends on them. Parallelise freely from step 4 onward.
- **`packages/contracts` is the contention point.** Two agents editing it concurrently will
  produce a merge that looks clean and is wrong. If your task needs a contract change, say
  so up front rather than editing it as a side effect.
- **Stay inside your slice.** Do not opportunistically refactor files another workspace is
  likely to own. A smaller diff that keeps the guard chain intact beats a larger one.
- **Rebase on `main` before you open a PR**, not after review starts.

## Stop and ask

Raise these rather than working around them (`STACK.md` §8, §10):

- A task needs a dependency from the "do not add" table.
- Available RAM drops below ~4 GB → the report worker moves to WeasyPrint.
- Multi-device concurrent editing of one audit is requested — the outbox design assumes one
  device owns an in-progress audit.
- Real-time collaborative auditing is requested — say no; it is a different product.
- A second organization is signed — multi-org tenancy touches every scope predicate.
- Anything in the authorization matrix reads ambiguously. Those are the ambiguities that
  matter here. Say so rather than picking silently.
