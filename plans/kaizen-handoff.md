# Kaizen handoff: Device A → Device B (2026-10-07)

The owner moved all remaining Kaizen work to Device B (see the handover note in
[`kaizen-module.md`](kaizen-module.md), under "Start every session"). Device B keeps working on
**`kaizen/geetahuja`**, and PRs go into **`feat/kaizen`**, never `main`. The owner merges them.

## Where things stand

| Step | State | Where |
|---|---|---|
| 1 contracts, migration 0044 | Done | PR #93 |
| 2 domain: state machine, counting rules | Done | PR #93 |
| 3 API module | Done | PR #94 |
| 7 Kaizen Sheet export, **as a PDF** | Done | PR #95 |
| 4, 5, 6 field app | Not started | Device B |
| 8 admin web | Not started | now Device B |
| 9 docs (R-48, ARCHITECTURE section), Maestro, cleanup | Not started | now Device B |

**The step 7 decision (owner, 2026-10-07):** the export is a redesigned one-page A4 PDF, not the
client's Excel filled in. Plan §4.6 says how it works. The theme is `apps/api/assets/kaizen-sheet.css`.
R-48 must record this under "the export renderer choice".

## The API the screens call (all under `/api/v1`)

`GET /kaizens`, `GET /kaizens/dashboard`, `GET /kaizens/analysis`, `GET /kaizens/:id`,
`POST /kaizens`, `PATCH /kaizens/:id`, `POST /kaizens/:id/submit`, `POST /kaizens/:id/review`
(Idempotency-Key header), photo `upload-intent` / `commit` / `DELETE`, and the export:
`POST /kaizens/:id/export` → 202 `{ exportId }`, then poll `GET /kaizens/:id/export/:exportId`
until `READY` and open `downloadUrl` (valid ≤ 5 minutes). Shapes: `packages/contracts/src/kaizen.ts`.
Every rule on who may do what: `apps/api/test/authorization-matrix.ts`.

## Suggested order

1. Steps 4 → 5 → 6, as planned (field app).
2. Step 8, admin web: module switch, then Kaizen list / detail / review / analysis, with an
   Export button on the detail.
3. Step 9.

## Local setup notes from Device A (not written down anywhere else)

- **Never point tests at the dev database.** The API e2e suite and the `packages/db` tests
  truncate whatever `DATABASE_URL` names. Use a separate `audit5s_test` database, created once as
  the `postgres` superuser: `CREATE DATABASE audit5s_test OWNER audit5s_owner`. Then run e2e with
  both URLs rewritten to it, and refuse to run otherwise:
  ```sh
  (set -a; . ./.env; set +a
   DATABASE_URL="${DATABASE_URL%/*}/audit5s_test"
   DATABASE_MIGRATION_URL="${DATABASE_MIGRATION_URL%/*}/audit5s_test"
   case "$DATABASE_URL$DATABASE_MIGRATION_URL" in *audit5s_test*audit5s_test*) ;; *) exit 1;; esac
   export DATABASE_URL DATABASE_MIGRATION_URL
   pnpm -r build && cd apps/api && pnpm test:e2e test/kaizens.e2e.test.ts)
  ```
- Run `pnpm -r build` before e2e. Stale `dist` output in the packages fails tests in confusing ways.
- `industries.e2e.test.ts` passes only on a fresh `audit5s_test`. Drop and recreate it between full runs.
- PDF rendering needs a Chromium locally. Set `CHROMIUM_EXECUTABLE_PATH` in `.env` to the
  installed Chrome if `playwright install` is slow on your network.
- Do not run Prettier on this repo: it reformats whole files.
- The full gate before every PR, from the repo root: `pnpm typecheck && pnpm lint`, the
  package tests one by one, and the e2e suites you touched.
