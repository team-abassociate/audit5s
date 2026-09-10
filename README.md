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
settled in **[DECISIONS.md](./DECISIONS.md)** (R-1 … R-6). The precedence rule is:
**`STACK.md` wins on any technology name, `ARCHITECTURE.md` wins on any behaviour.** The complete
list of superseded technology choices is at the top of `ARCHITECTURE.md`.

## Status

**Implementation in progress — see [HANDOFF.md](./HANDOFF.md).** Read it before starting: it
reconciles the blueprint with the real source files in
[`docs/requirements/`](./docs/requirements/) and defines the phase-by-phase work order.

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Reconcile the blueprint against the real workbook and sample reports (`HANDOFF.md` §5.1) | Done |
| 1 | Foundation, authentication, RBAC, users and Units (`ARCHITECTURE.md` PART 14) | Done |
| 2 | Coordinator, Zones, Zone Leaders, checklist versioning and Excel import | Next |

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
pnpm seed
pnpm -r test
```

Deployment, the required secrets and the restore drill are in
[`infra/README.md`](./infra/README.md).
