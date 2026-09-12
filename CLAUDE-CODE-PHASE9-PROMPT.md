Continue the audit5s project through Phase 9 (Hardening, observability, UAT and
production deployment). Phase 9 slice 1 — queue hardening — is done; you are picking up
slice 2.

Read `AGENTS.md` first, then `STACK.md` and `DECISIONS.md` in full, and
`HANDOFF-PHASE9.md`. Read only the relevant `ARCHITECTURE.md` section — PART 16 is the
checklist Phase 9 is measured against, and its subsections are short; read the ones your
slice touches, not the whole blueprint. `HANDOFF-PHASE8.md` is still the record for
anything analytics.

Repository state:

- Work from the current branch and verify it is based on `origin/main` before changing
  anything. At the end of Phase 9 slice 1, `origin/main` was `bc89a32` and PR #9 carried
  both Phase 8 and slice 1. **Check whether it merged**; if it did, rebase before you start
  rather than at review time.
- Migrations run through `0011_analytics.sql`; never edit an applied migration. `0012` is
  next. Slice 1 added no migration — pg-boss owns its own schema and nothing in it is a
  domain table.
- `HANDOFF-PHASE9.md` records the exact test totals, the R-16 findings, and the remaining
  Phase 9 work in the order it is worth doing. Do not reopen those decisions silently.
- Keep the global `JwtAuthGuard → PermissionGuard → ScopeGuard` chain, AZ-1 repository
  scope predicates, append-only rules, the pg-boss-only enqueue rule and shared domain
  scoring.

Two decisions were deliberately left open rather than picked silently. Settle the one your
slice needs, in `DECISIONS.md`, before you write the code:

- **How §16.4's data-integrity findings reach a Super Admin.** Orphan evidence, stale
  in-progress audits, devices unsynced past 48 h and nightly score reconciliation all ride
  the `maintenance.sweep` tick that is already scheduled per Unit. Surfacing them through
  the existing notification fan-out costs new notification types and no new route; a read
  endpoint costs a PART 6 change, because PART 6 has no ops or system resource. These are
  not equivalent and the choice is not reversible cheaply.
- **PgBouncer.** PART 14's Phase 9 backend row names it; `STACK.md` §4 describes six
  containers and it would be a seventh. It is not on the do-not-add table, but it is a
  technology name, so raise it rather than adding it — and note the workload is under 100
  users with `DATABASE_POOL_MAX` at 10.

Phase 9 is the last roadmap phase, so "done" is PART 16.14's go-live gates rather than
another phase. Several of them — the penetration test, UAT with real auditors in a real
facility, the load test at 3× peak, the restore rehearsal, store submission — need people,
a deployed environment and a production identity, not a commit. **Do not simulate them.**
Say plainly in the handoff which gates code cannot close, and finish the ones it can.

Before implementation, inspect the current worktree and identify the smallest complete
slice of what remains. Reuse existing contracts, repositories, domain helpers, workers and
rating-scale tokens. Do not add infrastructure from `STACK.md` §6's "do not add" table. If
your slice needs a contract or a migration, call that out before editing it. Add
authorization-matrix entries and tests with every new route, run lint/typecheck/build and
the relevant unit/e2e suites, and update the next handoff with exact counts and explicit
deferred work.

Two habits slice 1 earned the hard way, because three of its four findings were the same
mistake:

- **A rule that is written down is not a rule that is in force.** Two workers carried
  comments promising a dead-letter queue that did not exist, and the retention policy
  `STACK.md` §5 asks for by name was configured with option names the pinned pg-boss
  version ignores. When a document says something is set, grep for where it is read.
- **A cast that exists to make configuration compile is a bug report in waiting.** An
  `as unknown as` on an options object is what stopped the compiler from reporting the
  retention bug.

And one about tests: an intermittent failure is a finding, not noise. PART 15.7's
byte-stability test failed about one run in four for a real reason — the renderer stamped
the wall clock into the PDF metadata — and "flaky, re-run it" would have shipped a false
claim that R-14 depends on.

Do not open a PR until the branch is rebased on the then-current `main`.
