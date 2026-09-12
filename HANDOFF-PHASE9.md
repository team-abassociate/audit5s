# Handoff — Phase 9, slice 1 (queue hardening)

Written for the next agent. Read [`AGENTS.md`](./AGENTS.md) first; this file covers what
this slice built, what it found, and what the rest of Phase 9 still needs.

## Repository state

- Branch **`codex/phase8-analytics`**, based on `origin/main` **`bc89a32`**, one commit
  ahead of it from Phase 8 plus this one.
- Migrations still run to **`0011_analytics.sql`**. **This slice added no migration** —
  pg-boss owns its own schema, and nothing in it is a domain table.
- **No new routes**, so `authorization-matrix.ts` is unchanged. `GET /api/v1/health` was
  already in it and is still public.
- Baseline, all green: `pnpm lint`, `pnpm -r build`, `pnpm -r typecheck`;
  **547 unit tests** (283 domain, 137 db, 56 mobile, 71 api), **607 API e2e tests** across
  29 files, and the reports/public corrective-action real-browser smoke.

The `pnpm` PATH note from Phase 7 still applies: this phase used
`corepack enable --install-directory /tmp/audit5s-bin` and `PATH=/tmp/audit5s-bin:$PATH`.
The shim is not part of the repository.

## Why this slice, and what it left alone

PART 14's Phase 9 row is eleven backend items, five web, six mobile, and a test row whose
headline entries are a penetration test and UAT with real auditors in a real facility. Most
of it is not code: it needs a production deployment identity, a security firm, a plant, and
an on-call rotation. The smallest complete slice that *is* code, and that everything else in
the phase leans on, is **"a job that fails leaves something behind, and a restart loses
nothing"** — PART 14's "graceful shutdown and queue draining" and "DLQ handling and
alerting", plus the parts of §16.1, §16.2 and §16.12 they satisfy.

## What was built

| Track | What landed |
| --- | --- |
| Queue | A `<queue>.dlq` dead-letter companion for all six queues; retry policy set **on the queue** so a `send` with no options still retries and still dead-letters; `createQueue` followed by `updateQueue`, because `create_queue` is `ON CONFLICT DO NOTHING` and a policy change would otherwise reach only a fresh database |
| Queue | Retention applied where pg-boss 12 actually reads it (`deleteAfterSeconds`); `PGBOSS_ARCHIVE_COMPLETED_AFTER_SECONDS` and `PGBOSS_DELETE_ARCHIVED_AFTER_DAYS` replaced by `PGBOSS_JOB_RETENTION_DAYS` |
| Queue | §16.1's per-job log line — queue, job id, attempt number, duration, outcome — wrapped once in `QueueService.work` rather than in each of the six workers; pg-boss's own `warning` events (`queue_backlog`, `slow_query`, `clock_skew`) are logged instead of being emitted to nobody |
| Queue | `onModuleDestroy` drains with an explicit 150s timeout and logs how long it took |
| Health | `/health` gains a `queue` check: **200 with `degraded`** while a job sits on a dead-letter queue, naming the queue. `HealthCheck.checks[].status` gains `'degraded'` — the one contracts change in this slice |
| Analytics | The Super Admin dashboard's `deadLetterCount` reads the same live count instead of pg-boss's cached `failed_count`, which is a minute stale by design |
| Reports | `freezePdfDates`: Skia's `/CreationDate` and `/ModDate` are rewritten to the payload's frozen `generatedAt`, in place and at the same width so the cross-reference table stays valid |
| Compose | `stop_grace_period: 180s` on `api`, `worker-general` and `worker-report`, above the 150s drain; the dead `WORKER_QUEUES` variable removed |

## What it found — DECISIONS.md R-16

Three of the four findings are the same mistake: a policy that was written down, believed,
and not in force.

- **No queue had a dead letter.** `createQueue` was called with no options. Two workers
  carry comments promising that a failed job "dead-letters where a human can see it", and
  `STACK.md` §5 asks for it by name for the report worker. A job that exhausted its retries
  stopped at `failed` and was deleted with the queue's history.
- **The retention policy configured a mechanism pg-boss 12 does not have.** The constructor
  was passed `archiveCompletedAfterSeconds` and `deleteAfterDays` — pg-boss 9 names, silently
  ignored — behind an `as unknown as ConstructorParameters<…>` cast that stopped the compiler
  from saying so.
- **PART 15.7's byte-stability test was not flaky; the renderer was wrong.** It failed about
  one run in four on a clean tree. Skia stamps the wall clock into the PDF metadata to the
  second, so two renders inside one second agreed and two across a boundary did not. R-14's
  "the same payload renders to the same bytes" was false, and the renderer's own "no clock"
  comment listed three clocks it had switched off and missed the fourth. Diagnosed by
  rendering the fixture until two differed and byte-diffing them: two bytes, both in
  `/CreationDate` and `/ModDate`.
- **Draining was not allowed to finish.** pg-boss's `stop` already waited for in-flight
  handlers; `docker compose`'s default `stop_grace_period` is ten seconds, so SIGTERM was
  followed by SIGKILL well inside a 120-second render.

## Tests added and final counts

`apps/api/test/queue-dead-letter.e2e.test.ts` adds three:

1. The queue check reports `ok` while nothing has been dead-lettered.
2. A job that exhausts its retries is copied onto its dead-letter queue with its payload.
3. `/health` answers **200** with `degraded`, names the dead-letter queue, and leaves the
   database check `ok`.

`apps/api/test/report-render.e2e.test.ts` adds one: the PDF's `/CreationDate` and `/ModDate`
are the payload's frozen instant, asserted separately so a regression names the cause rather
than reappearing as intermittent failure. Its byte-stability test then passed four runs in
four, and the fixture rendered identically thirty-one times in a row during diagnosis.

Final totals:

- Domain: **283** · Database: **137** · Mobile: **56** · API unit: **71** · Unit total: **547**
- API e2e: **607** across 29 files
- Browser: **1** reports + public corrective-action smoke, including camera capture

## Deliberately not added

- **No new dependency and nothing from the "do not add" table.** No Redis, no Prometheus,
  no OpenTelemetry SDK. §16.2's golden signals want a metrics pipeline, and `STACK.md` §6
  gates that on having an on-call rotation.
- **No new route and no new permission.** PART 6 has no ops or system resource, so any
  `GET /ops/*` surface is a matrix change to raise before writing, not a side effect.
- **No stalled-queue alarm.** §16.12's paging condition, "queue stalled >15 min", needs the
  age of the oldest ready job. pg-boss's cached counters do not carry it and neither does
  `getQueues()`; it wants a query over `pgboss.job` and a decision about where that lives.
  Only the warning half of §16.12 is built.

## The rest of Phase 9, in the order it is worth doing

1. **§16.4 data-integrity jobs — none exist.** Orphan evidence (rows with no object after
   24 h), stale in-progress audits (>7 days), devices unsynced >48 h, nightly score
   reconciliation. They ride the `maintenance.sweep` tick that is already scheduled per Unit.
   Surfacing them to Super Admin has two candidate paths and they are not equivalent: the
   existing notification fan-out (no new route, but new notification types) or a new
   read endpoint (a PART 6 change). **Decide that before writing either.**
2. **Sentry (§16.3).** `SENTRY_DSN` is in `.env.example`, in `config/env.ts` and in the
   compose env block, and is read by nothing. Either wire it or delete it; a configured DSN
   that reaches no SDK is worse than an absent one.
3. **CI: dependency and secret scanning (§16.7, §16.9).** Neither is in `ci.yml`, and both
   are required on every PR.
4. **Runbooks (§16.13).** `docs/runbooks/` holds `privacy.md` only. Incident response,
   restore, key rotation, checklist import and conflict resolution are all named.
5. **JWT signing-key overlap (§16.7).** "Rotation supports overlap (two valid signing keys)
   so rotation needs no downtime." Today there is one key pair and rotating it invalidates
   every live access token.
6. **PgBouncer (§14 Phase 9 backend row).** It would be a seventh container against
   `STACK.md` §4's six. Not on the do-not-add table, but it is a technology name, so
   **raise it rather than adding it** — and note the workload is <100 users and
   `DATABASE_POOL_MAX` is 10.
7. Load test at 3× peak, penetration test, restore rehearsal, UAT, store submission — all
   go-live gates in §16.14 that need people and a deployed environment, not a commit.

No PR was opened. Rebase on `main` immediately before opening one; `origin/main` was
`bc89a32` when this slice started.
