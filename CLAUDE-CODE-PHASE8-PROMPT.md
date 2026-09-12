Continue the audit5s project after Phase 8 Analytics.

Read `AGENTS.md` first, then `STACK.md`, `DECISIONS.md` in full, and
`HANDOFF-PHASE8.md`. Read only the relevant `ARCHITECTURE.md` section and the next
unimplemented Phase 14 roadmap row; do not read the whole blueprint.

Repository state:

- Work from the current branch and verify it is based on `origin/main` before changing
  anything. At Phase 8 completion, `origin/main` was `bc89a32`.
- Migrations run through `0011_analytics.sql`; never edit an applied migration. `0012` is
  next.
- The Phase 8 handoff records the exact test totals, R-15 decisions, browser smoke and the
  four Phase 7 leftover dispositions. Do not reopen those decisions silently.
- Keep the global `JwtAuthGuard → PermissionGuard → ScopeGuard` chain, AZ-1 repository
  scope predicates, append-only rules, pg-boss-only enqueue rule and shared domain scoring.

Before implementation, inspect the current worktree and identify the next phase’s smallest
complete slice. Reuse existing contracts, repositories, domain helpers and rating-scale
tokens. Do not add infrastructure from STACK.md’s “do not add” table. If the next phase
needs a contract or migration, call that out before editing it. Add authorization-matrix
entries and tests with every new route, run lint/typecheck/build and the relevant unit/e2e
suites, and update the next handoff with exact counts and explicit deferred work.

Do not open a PR until the branch is rebased on the then-current `main`.
