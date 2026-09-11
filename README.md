# audit5s

Production-grade 5S Audit Management Platform — admin web portal, offline-first field mobile
application, and a NestJS/PostgreSQL backend.

## Architecture

The complete design and implementation blueprint lives in **[ARCHITECTURE.md](./ARCHITECTURE.md)**:
domain model, authorization matrix, state machines, database schema, REST API, offline
synchronization protocol, reporting pipeline, analytics, security review, repository layout,
a nine-phase roadmap, testing strategy and the production-readiness checklist.

Read PART 1 first — it settles the vocabulary and every contradiction in the source
requirements, and its decisions are binding.

The stack itself — every technology choice, the six containers, the "do not add" list and the
build order — is the Stack Decision Record in **[STACK.md](./STACK.md)**. It supersedes
`ARCHITECTURE.md` PART 3.1.

Points where the blueprint and `STACK.md` disagreed or were silent are
settled in **[DECISIONS.md](./DECISIONS.md)** (R-1 … R-12). The precedence rule is:
**`STACK.md` wins on any technology name, `ARCHITECTURE.md` wins on any behaviour.** The complete
list of superseded technology choices is at the top of `ARCHITECTURE.md`.

## Status

**Implementation in progress — see [HANDOFF.md](./HANDOFF.md).** Read it before starting: it
reconciles the blueprint with the real source files in
[`docs/requirements/`](./docs/requirements/) and defines the phase-by-phase work order.
[`HANDOFF-PHASE5.md`](./HANDOFF-PHASE5.md) carries the current state of the phase in flight.

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Reconcile the blueprint against the real workbook and sample reports (`HANDOFF.md` §5.1) | Done |
| 1 | Foundation, authentication, RBAC, users and Units (`ARCHITECTURE.md` PART 14) | Done |
| 2 | Coordinator, Zones, Zone Leaders, checklist versioning and Excel import | Done |
| 3 | Audit engine and scoring | Done |
| 4 | Mobile camera, selfie, GPS and the synchronization engine | Done |
| 5 | Walk-by audit and evidence management | Done |

## Layout

```
apps/
  api/            NestJS 11 on Fastify — api, worker-general, worker-report, seed
  admin-web/      React 19 + Vite 7 SPA, including the corrective-action route
  field-mobile/   React Native + Expo (Android), expo-router
packages/
  contracts/      Zod schemas + inferred types — every type crossing an app boundary
  domain/         Pure logic: login IDs, rating scale, permission matrix, scoring
  db/             Drizzle schema + SQL migrations, RLS policies, append-only triggers
infra/            compose, bootstrap.sh, pgBackRest, runbooks
```

pnpm workspaces, no Turborepo (`STACK.md` §6).

## Working on it

```sh
pnpm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
pnpm db:migrate
pnpm seed          # permission matrix, the Super Admin, and the nine department checklists
pnpm -r test       # unit tests
pnpm --filter @audit5s/api test:e2e   # authorization matrix, import pipeline, acceptance
```

`pnpm seed` imports `docs/requirements/5S_lean_audit_data_1.xlsx` through the real import
pipeline and publishes each department as v1, so the seed is also the importer's first
integration test. It is idempotent: a re-run finds every sheet unchanged and commits nothing.

Two browser-driven walkthroughs run against a live API and `worker-general`, in order —
the second one runs in the world the first leaves behind:

```sh
node apps/admin-web/smoke.mjs         # Super Admin: Units, users, Zones, the import wizard
node apps/admin-web/smoke-audit.mjs   # a device runs a real audit; the board renders it
```

`smoke.mjs` signs in with the bootstrap credential and rotates it, so it needs a database
`pnpm seed` has only just touched. The admin bundle reads `VITE_API_BASE_URL` at build time;
if the API is not same-origin with the preview server, build it with that variable set and
list the preview origin in `CORS_ORIGINS`.

They exist because some failures are only visible in a browser: the CORS method allow-list
that silently refused every `PATCH` and `PUT` cross-origin was found by the second one and
by nothing else, since `app.inject` does not perform a preflight. `smoke-audit.mjs` also
carries the only end-to-end exercise of the media flow — upload intent, a presigned `PUT`
that deliberately carries **no** session, `commit`, and a presigned `GET` fetched back out
of process (`DECISIONS.md` R-9).

Deployment, the required secrets and the restore drill are in
[`infra/README.md`](./infra/README.md).
