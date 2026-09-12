# Handoff — end of Phase 8 (Analytics)

Written for the next agent. Read [`AGENTS.md`](./AGENTS.md) first; this file only covers
what Phase 8 built, what it decided, and what remains.

## Repository state

- Branch **`codex/phase8-analytics`**, based on `origin/main` **`bc89a32`**. `origin/main`
  was fetched again at the end of the phase and had not moved.
- Migrations run to **`0011_analytics.sql`**; `0012` is next. Never edit `0011` after it
  has been applied—the migration ledger stores a checksum.
- Baseline, all green: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r build`;
  **547 unit tests** (283 domain, 137 db, 56 mobile, 71 api), **603 API e2e tests**, and
  the reports/public corrective-action real-browser smoke.

The `pnpm` PATH and Playwright browser requirements from Phase 7 still apply. Locally this
phase used a temporary `corepack enable --install-directory /tmp/audit5s-bin` shim and
`PATH=/tmp/audit5s-bin:$PATH`; the shim is not part of the repository.

## What was built

| Track | What landed |
| --- | --- |
| Schema | `0011`: `metric_daily_unit`, `metric_daily_zone`, `metric_section_daily`; unique grains, RLS, no-delete triggers, analytics B-tree indexes and BRIN on `audit_log.occurred_at` |
| Contracts | `packages/contracts/src/analytics.ts`: validated query parameters and shared response shapes for overview, trends, rankings, sections, recurrence, closure, activity and sync health |
| Domain | The completed-status set is exported beside `isAuditCompleted()` so analytics and the audit state machine cannot drift |
| API | `modules/analytics/`: all 16 §11.1 metrics through guarded, scoped repository queries; organization and Unit dashboards; recurrence, closure and activity endpoints |
| Rollups | One pg-boss `maintenance.sweep` schedule per Unit at 02:00 in its timezone; previous-local-day rebuilds with row-stable idempotent upserts |
| Web | Super Admin organization KPIs and Unit ranking; Coordinator Unit KPIs, trends, S radar, Zone ranking, open findings, closure funnel and recurrence; CSV export and a table toggle behind every chart |
| Mobile | Consultant “My activity” summary on the profile tab |
| Browser | `smoke-reports.mjs` loads report history/link management and drives `/ca` through fake-camera `getUserMedia` capture; it checks no file input, `no-referrer`, and zero console errors, and runs in CI |

Score recomposition stores daily `raw_score` and `max_score` and always calls the shared
domain aggregation. Walk-bys participate in activity but have no score contribution;
fully-NA sections remain `null`. Rankings expose sample counts and leave `rank` null below
the configurable minimum, default three scored audits.

## Decisions this phase made — DECISIONS.md R-15

- **Weighted scores win:** PART 11's illustrative `avg(percentage)` conflicts with the
  established scoring rule, so every aggregate remains `Σraw / Σmax`. Raw and max totals
  live in the derived rollups so month and organization recomposition stays correct.
- **Own activity gets a route:** `GET /analytics/activity/me` is the transport missing
  between PART 6's `analytics:own_activity` grant and the required mobile summary.
- **Nightly identity and day:** one stable schedule per Unit rebuilds the previous complete
  local day under the derived-table system write context. Rerunning the same day changes no
  identical row.

## Tests added and final counts

`packages/db/src/analytics-schema.test.ts` adds four database tests: unique grains,
no-delete enforcement, Coordinator RLS and the BRIN index.

`apps/api/test/analytics.e2e.test.ts` adds seven Phase 8 tests:

1. Unit-timezone bucketing across a month boundary.
2. Weighted aggregation, walk-by score exclusion and minimum-sample rank suppression.
3. Fully-NA sections stay null and out of averages.
4. Recurrent nonconformities and walk-by-inclusive Consultant activity.
5. Row-identical rollup reruns.
6. Organization, own-Unit and own-record authorization.
7. Dashboard p95 below 500 ms on two years of rollups.

Final totals:

- Domain: **283**
- Database: **137**
- Mobile: **56**
- API unit: **71**
- Unit total: **547**
- API e2e: **603** across 28 files
- Browser: **1** reports + public corrective-action smoke, including camera capture

## Phase 7 leftovers — explicit disposition

1. **Reports schema test: not picked up.** RS-1, token CHECKs and no-delete behavior remain
   covered by the report API e2e suite. Phase 8 added its own database tests in the normal
   package location; moving existing Phase 7 assertions was lower value than browser
   coverage.
2. **Phase 7 architecture change record: not picked up.** R-14 remains the binding and
   complete reconciliation. Rewriting the blueprint was outside the Phase 8 slice.
3. **Reports and `/ca` browser coverage: picked up.** The repeatable Chromium smoke now
   covers both surfaces and the previously untouched `getUserMedia` path, and CI runs it.
4. **Android `assetlinks.json`: not picked up.** Publishing it needs the production web
   origin, Android package name and signing certificate fingerprint; those belong in the
   deploy runbook when that deployment identity exists. The chooser fallback remains.

## Deliberately not added

- No warehouse, materialized view, Redis/cache tier or separate scheduler. The three
  derived tables are the only analytics cache, as §11.4 requires.
- No second scoring implementation and no chart-specific palette. Analytics imports the
  domain score and rating-scale tokens.
- No PR was opened from this handoff. Rebase on `main` immediately before opening one if
  `origin/main` moves after `bc89a32`.
