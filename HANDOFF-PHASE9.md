# Handoff — Phase 9

Written for the next agent. Read [`AGENTS.md`](./AGENTS.md) first. Two slices are recorded
here: **slice 1, queue hardening**, and **slice 2, §16.4's data-integrity jobs**. The
"rest of Phase 9" list at the end is current as of slice 2.

---

# Slice 1 — queue hardening

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

---

# Slice 2 — §16.4's data-integrity jobs

## Repository state

- Same branch **`codex/phase8-analytics`**. `origin/main` was still **`bc89a32`** when this
  slice started and **PR #9 had not merged**, so no rebase was needed; the branch is two
  commits ahead of `origin/main` plus this one.
- Migrations still run to **`0011_analytics.sql`**. **This slice added no migration.** It
  did not need one: `notification.event_type` is `text`, and migration 0009 says why on the
  column — *"a new event type must not need a migration."* `0012` is still next and still free.
- **No new route**, so `authorization-matrix.ts` and PART 6 are unchanged. That was the
  decision, not a coincidence — see R-17.
- **One `packages/contracts` change**, flagged here because contracts is the contention
  point: `DATA_INTEGRITY_ALERT` added to `NOTIFICATION_EVENT_TYPES`. Nothing was removed or
  renamed, so it is additive for every consumer; the admin web's preference grid is
  data-driven and renders the new row without a change.

The `pnpm` PATH note still applies: `corepack enable --install-directory /tmp/audit5s-bin`,
then `PATH=/tmp/audit5s-bin:$PATH`. Note that `apps/api` typechecks against the *built*
`packages/contracts`, so a contracts edit needs
`pnpm --filter @audit5s/contracts build` before `pnpm -r typecheck` tells the truth.

## The decision this slice had to settle first

`DECISIONS.md` **R-17**: §16.4's findings reach a Super Admin through the **existing
notification fan-out**, not a read endpoint. The argument that decided it is not "fewer
files" — it is that *a read endpoint has to read something*. The sweep runs at 02:00 and a
Super Admin looks at 09:00, so a route would need the findings persisted: a new domain
table, migration `0012`, plus an `ops` resource PART 6 does not have, plus a permission, a
scope rule, seed rows and matrix tests. The notification row is **both the delivery and the
durable record**, so that whole question disappears rather than being answered. §16.4 also
says "surfaced", not "queryable", and nobody opens a page that is empty 364 nights a year.

## What was built

| Track | What landed |
| --- | --- |
| Sweep | `IntegrityWorker` + `IntegrityRepository` in a new `modules/maintenance/`. Four checks per Unit, on the `maintenance.sweep` tick that already runs at 02:00 in each Unit's timezone — no second schedule to keep in step |
| Checks | Orphan evidence (`sync_state <> 'SYNCED'` older than 24 h, excluding deleted and redacted rows); stale audits (`IN_PROGRESS`/`PAUSED` started >7 days ago); quiet devices (owning an unfinished audit, `last_sync_at` older than 48 h or never); score reconciliation (the 20 most recently completed scored audits, recomputed through `ScoringService.summarise`) |
| Reporting | `DATA_INTEGRITY_ALERT` — one event per Unit per night, **only when a count is non-zero**, in-app only, Super Admin only. The body names just the findings that fired; the counts also survive in `notification.data` |
| Logging | The counts go to the Super Admin; the **identifiers** go to the log — stale audit ids, device ids with their last sync, and each drifted audit's stored-vs-recomputed pair. A notification saying "1 audit open for more than a week" is not actionable on its own |
| Refactor | `SYSTEM_SCOPE` moved from `analytics-rollup.worker.ts` to `common/auth/system-scope.ts`. Two jobs now need it and a second copy is the one that would drift into reading more than it should |
| Fix | **`worker-general` could not start.** See below |

**Nothing in this slice writes to a domain table or repairs anything.** A sweep that
silently fixed an orphan would be a delete by another name, and an audit whose score the
night shift rewrote is exactly the change §16.4 exists to notice. A test asserts the
drifted score is still drifted after the sweep has seen it.

## What booting the worker found — a Phase 8 bug, not a Phase 9 one

`worker-general` **crashed on startup**, on every environment, from Phase 8 onwards:

```
AssertionError: Key can only contain alphanumeric characters, underscores,
hyphens, periods, or forward slashes
  at PgBoss.schedule … at AnalyticsRollupWorker.schedule
```

`AnalyticsRollupWorker.schedule` built its pg-boss schedule key as `analytics:${unit.id}`.
pg-boss 12 validates a schedule key against `/^[\w.\-/]+$/` and asserts on anything else, so
the colon threw — **before the process had registered a single handler**. The nightly rollup
never ran, and neither would this slice's sweep, which rides the same tick.

Nothing caught it because every suite drives `handle()` directly and none had ever called
`schedule()`; the failure only appears when `worker.general.ts` is actually booted. It was
found by doing exactly that, against a local Postgres, while writing the run instructions —
not by a test.

The key is now `analytics.${unitId}` through one `scheduleKey()` helper, and
`analytics.e2e.test.ts` gains a test that calls `schedule()` against real pg-boss and asserts
the row lands in `pgboss.schedule`. It fails with the old key — verified by reverting it.

**The lesson is slice 1's, again, in a new costume:** a scheduled job that is scheduled by
code that throws is a job that was written down and never in force. Worth a habit for the
next agent: *boot the entrypoints*, not only the suites. `worker.report.js` and `main.js`
both start clean; `worker-general` was the one nobody had run.

## What was deliberately not built, and when to build it

- **The orphan-*object* sweep (§16.4's second box).** §16.4 answers it in the same line —
  *"objects with no evidence row (should be empty by design)"* — and the design holds in
  both directions: the evidence row is inserted **before** the key is presigned, and
  nothing is ever hard-deleted (R-5 erasure overwrites the object and keeps the row). The
  one leftover the code can produce is a thumbnail whose row update failed, and its key is
  derived deterministically so the next attempt overwrites it rather than accumulating.
  Building it would mean a `list(prefix)` method on the `ObjectStorage` port, both drivers,
  and a nightly `ListObjectsV2` per Unit against R2, to re-verify a guarantee `BEFORE DELETE`
  triggers already hold. **Build it when a hard-delete path appears, or when anything other
  than the API writes into the bucket.** (R-17d.)
- **§16.4's "outbox dispatcher lag alert" is not applicable, not outstanding.** R-2 removed
  `domain_event`; there is no outbox to lag. The nearest live concern is §16.12's "queue
  stalled >15 min", still open from slice 1 (R-16c).
- **No new environment variables.** §16.4 fixes all four thresholds by name, so they are
  constants in `integrity.worker.ts`. Changing one is a one-line PR, not a deployment knob
  to keep true in `.env.example`, compose and `config/env.ts`.
- **No new dependency and nothing from the "do not add" table.**

## Tests added and final counts

`apps/api/test/data-integrity.e2e.test.ts` adds four. The suite seeds **the same four faults
in Unit A and in Unit B**, because a count is the one shape of result where a missing scope
predicate looks like a plausible number rather than an error:

1. The sweep finds exactly one of each fault in Unit A and none of Unit B's — and the
   fixtures that must *not* count are seeded too: a `SYNCED` evidence row, a redacted one,
   and a walk-by that has no score to reconcile (§2.7).
2. It changes nothing: the drifted audit still reads 4/4 afterwards.
3. The alert reaches the Super Admin's notification centre, with the exact body, the counts
   in `data`, and an `IN_APP` delivery row and no other.
4. A clean Unit raises no notification at all.

`analytics.e2e.test.ts` adds one: the scheduling path above.

`notification-policy.test.ts` adds three: only the non-zero findings are named (singular and
plural both), the drift line reports the sample it was drawn from, and the alert is Super
Admin only with no external channel.

Final totals, all green (`pnpm lint`, `pnpm -r build`, `pnpm -r typecheck`):

- Domain: **283** · Database: **137** · Mobile: **56** · API unit: **74** · Unit total: **550**
- API e2e: **612** across 30 files (611 for this slice + 1 for the scheduling regression)
- Browser: **1** reports + public corrective-action smoke, including camera capture

PART 15.7's byte-stability test passed in every run of this slice, including two full e2e
sweeps — R-16(d)'s fix is holding.

---

## Raised, not decided: PgBouncer

PART 14's Phase 9 backend row names it. It is **not** on `STACK.md` §6's do-not-add table,
but it is a technology name, so R-1 puts it to the owner rather than to an agent. The facts,
so the decision can be made in one reading:

- `STACK.md` §4 describes **six containers**. PgBouncer would be a seventh, on a 12 GB box
  whose steady state is already ~4.0 GB and whose peak is ~6.7 GB (§9).
- The workload is **<100 users, ~120 audits/month, ~200 jobs/day**, and `DATABASE_POOL_MAX`
  is **10**. Transaction pooling solves connection *exhaustion*; there is none to solve.
- The API is a single replica. Two pools would then be sized against each other for no
  measured contention.
- Against: it also breaks `SET LOCAL`-style session state in transaction mode — and
  `setActorContext` sets `app.actor_id` / `app.actor_role` per transaction, which every RLS
  policy reads. Transaction pooling keeps `SET LOCAL` correct *within* a transaction, so the
  current code is compatible, but it makes any future session-scoped `set_config` a
  silent authorization bug rather than a compile error. That is the real cost, and it is
  paid in the most expensive part of this codebase.

**Recommendation: do not add it now.** Revisit when either a second API replica is deployed
or connection count becomes a measured problem. It is not on the go-live gates.

## Running it locally — two things `.env.example` does not say

Both found by doing it, and both worth fixing in a follow-up:

1. **Nothing loads `.env`.** There is no `dotenv` anywhere in the repo; `.env` is read only
   by `docker compose` for variable substitution. Running the API, a worker, `pnpm
   db:migrate` or `pnpm seed` directly on the host needs the variables exported —
   `set -a; . ./.env; set +a` — or every one of them fails on config validation. The
   `.env.example` header says "Copy to .env for local development", which is true only if
   you also source it.
2. **`.env.example` as shipped cannot boot the API.** It carries
   `OBJECT_STORAGE_SIGNING_SECRET=` empty, and the schema requires ≥16 characters *when
   set*. An empty string is set. The comment above it says "Unset means a fresh key per
   process", which is the intent — so the fix is either to delete the line from the example
   or to treat an empty string as absent in `config/env.ts`. Same shape of bug as R-16(b):
   a setting that documents one behaviour and implements another.

## The rest of Phase 9, in the order it is worth doing

1. **Sentry (§16.3).** `SENTRY_DSN` is in `.env.example`, in `config/env.ts` and in the
   compose env block, and is read by nothing. Either wire it or delete it; a configured DSN
   that reaches no SDK is worse than an absent one. This is now the largest "written down
   but not in force" item left, which slice 1 learned the hard way is the expensive kind.
2. **CI: dependency and secret scanning (§16.7, §16.9).** Neither is in `ci.yml`, and both
   are required on every PR.
3. **Runbooks (§16.13).** `docs/runbooks/` holds `privacy.md` only. Incident response,
   restore, key rotation, checklist import and conflict resolution are all named. §16.12
   also requires every alert to carry a runbook link — the dead-letter alert from slice 1
   and the integrity alert from this one both currently have none.
4. **JWT signing-key overlap (§16.7).** Today there is one key pair and rotating it
   invalidates every live access token.
5. **§16.12's paging half — "queue stalled >15 min".** Still open from slice 1: it needs the
   age of the oldest ready job, which pg-boss's cached counters do not carry. A query over
   `pgboss.job`, and a decision about where it lives.
6. **PgBouncer** — raised above, not decided. Owner's call.

## The go-live gates code cannot close (§16.14)

Phase 9 is the last roadmap phase, so "done" is §16.14 rather than another phase. These need
people, a deployed environment and a production identity. **Do not simulate them, and do not
report them as passing:**

- UAT signed off by the business with real auditors in a real facility
- Penetration test completed, high/critical findings remediated
- Restore rehearsal completed and documented (§16.5 makes this release-blocking, quarterly)
- Load test at 3× expected peak
- Monitoring, alerting and on-call live — §16.2's golden signals also wait on `STACK.md` §6,
  which gates a metrics pipeline on having an on-call rotation
- CH-1's password decision formally recorded and accepted by a named owner
- Rollback plan documented **and rehearsed**
- Play Store submission

Of these, only the rollback plan's *documentation* and CH-1's *recording* are things a
commit can move, and both are documents awaiting a named owner rather than code.

No PR was opened by this slice either. **Rebase on the then-current `main` immediately
before opening one** — `origin/main` was `bc89a32` and PR #9 was open when this slice
finished.
