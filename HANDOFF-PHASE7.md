# Handoff — end of Phase 7 (PDF/reporting engine and live reports)

Written for the next agent. Read [`AGENTS.md`](./AGENTS.md) first; this file only covers
what Phase 7 did, what it decided, and what is left.

## Repository state

- Branch **`Claude/KrishnaSuperset`**, head `990ff5f`. Four commits, not yet pushed and not
  yet merged to `main` (phases 0–5 are on `main`; 6 and 7 are on branches).
- Migrations run to **`0010_reports.sql`**; `0011` is next.
- Baseline, all green: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r build`;
  **543 unit tests** (283 domain, 133 db, 56 mobile, 71 api) and **546 API e2e tests**.

### Running the suites locally

Two things that are not obvious and cost time to rediscover:

1. **`pnpm` must be on `PATH`.** `apps/api/test/harness.ts` shells out to `pnpm` to apply
   migrations. If only `corepack pnpm` works in your shell, put a two-line shim on `PATH`
   or the whole e2e suite fails with `spawnSync pnpm ENOENT` and 503 skipped tests.
2. **The e2e suite needs a browser** for `report-render.e2e.test.ts` and
   `acceptance-phase7.e2e.test.ts`:
   `pnpm --filter @audit5s/api exec playwright install chromium-headless-shell`.
   CI does this with `--with-deps`. A missing browser **fails** rather than skipping, on
   purpose — a determinism test that quietly stops running is worse than no test.

## What was built

| Track | What landed |
| --- | --- |
| Schema | `0010`: `report_snapshot`, `report_access_token`, the `corrective_action_submission.access_token_id` FK that `0009` left dangling, RS-1's immutability trigger, two narrow `SECURITY DEFINER` name functions |
| Contracts | `packages/contracts/src/report.ts` — the frozen payload, the snapshot, the token, the public page's shape |
| API | `apps/api/src/modules/reports/` — payload freezing, versioning, the render queue, the Chromium renderer, token minting/validation/revocation, the public signed-token surface |
| Templates | `modules/reports/templates/` — React → HTML → CSS `@page`, one template for both zone kinds, server-computed inline SVG for the radar and the bars |
| Guard chain | `common/auth/signed-token.guard.ts` + the `signed_token` scope resolver |
| Web | `features/reports/ReportsPage.tsx`, `features/corrective-actions/PublicCorrectiveActionPage.tsx`, and the router change that puts `/ca/$token` outside the auth gate |
| Mobile | `app/audit/summary/[auditId].tsx` (the Consultant score summary), `app/ca/[token].tsx` (deep links), an Android App Link intent filter |
| Infra | Alpine Chromium in the runtime image, `chrome-headless-shell` in CI |

`GET /audits/{id}/summary` was **already implemented in Phase 3** — Phase 7 only added the
tests for the Consultant path (N6) and the mobile screen that consumes it.

## Decisions this phase made — DECISIONS.md R-14

Read R-14 in full before changing anything in `modules/reports`. The six parts, in one
line each:

- **(a)** Tokens are minted **before** the render and frozen into the payload, contradicting
  §10.2's pipeline sketch — because the PDF prints the link. Minting is two halves on one
  transaction (`prepareForSnapshot` → insert snapshot → `persist`) because the token FKs the
  snapshot while the payload must already carry the URL.
- **(b)** Photographs are fetched from object storage **before Chromium starts** and embedded
  as `data:` URIs, not resolved as presigned GETs inside the page. Determinism is the
  requirement, and the network in the middle of a render breaks it.
- **(c)** The public submission **commits the after-photo itself**, so the link still
  authorizes only the operations §10.4 names rather than needing a fourth public route.
- **(d)** `signed_token` narrows and never widens: one action, one Unit, against a resolver
  that would otherwise admit the whole Unit (R-3b). `SignedTokenGuard` runs before
  `JwtAuthGuard`; the two guards after it run unchanged. These routes are **not** `@Public()`.
- **(e)** A display name is never a reason to join a table the reader cannot see. Two
  `SECURITY DEFINER` functions, in 0008's shape.
- **(f)** A version belongs to the **Zone**, not to the kind: v1 `INITIAL_ZONE` → v2
  `AFTER_EVIDENCE_ZONE` is one chain. `regenerate` re-issues the same kind; an
  after-evidence report goes through `generate`.

## Rules that will bite you here

- **`RS-1` is a trigger.** A `READY` snapshot refuses every `UPDATE`, and `payload`,
  `version`, `kind` and the target refuse one at any status. If you need a different
  document, insert a version.
- **The templates must stay free of JavaScript-dependent layout** (STACK.md §5). No chart
  library, no measured layout, no web font. The escape hatch to WeasyPrint (STACK.md §8's
  RAM tripwire) depends on it, and `templates.test.ts` asserts there is no `<script>`.
- **The renderer must stay deterministic.** No clock, no network at render time, no
  animation. `report-render.e2e.test.ts` renders one fixed payload twice and compares bytes,
  with a control that asserts a *different* payload differs — so the test can fail.
- **`/ca/$token` is the one surface outside the organization.** It uses no shared API
  client, carries no session, has no file picker, and every request and image is
  `no-referrer` — the token is in the URL, so a default `Referer` would hand the secret to
  object storage's access logs. Keep all four properties if you touch that file.
- **Editing `0010` means resetting the local databases.** The migration ledger stores a
  checksum. There is a drop-and-reapply sequence in this session's history; `audit5s_test`
  may also hold `corrective_action_submission` rows whose `access_token_id` blocks the FK,
  and CA-1 refuses an `UPDATE` on them, so they have to be truncated with
  `session_replication_role = replica` as a superuser.

## What is left

Nothing from PART 14's Phase 7 row is outstanding. Four things are deliberately not done:

1. **`packages/db/src/reports-schema.test.ts` does not exist.** Every earlier phase has a
   `*-schema.test.ts` beside its migration. RS-1, the token audience CHECKs and the
   no-delete triggers *are* asserted, but from `apps/api/test/reports.e2e.test.ts` rather
   than from the `packages/db` suite. Moving them would match the pattern and run faster.
2. **`ARCHITECTURE.md` has no Phase 7 change record.** Phase 6 added one (`git show 3b3cdda
   -- ARCHITECTURE.md`), and `README.md` was updated too. Worth doing for consistency;
   §10.2's pipeline ordering and §5.8's version index are the two places the text now reads
   differently from the code, and both are explained in R-14 rather than in the blueprint.
3. **No browser walkthrough for the reports UI.** Phase 6's commit message mentions two
   walkthroughs passing with no console errors. The `ReportsPage` and the `/ca/$token` page
   have not been driven in a real browser — only typechecked and built. **This is the
   biggest untested surface in the phase.** The `/ca` page in particular has a
   `getUserMedia` path that no automated test exercises.
4. **`assetlinks.json` is not published.** The Android intent filter is `autoVerify: true`,
   which needs `/.well-known/assetlinks.json` on the web origin. Until it is there, Android
   shows a chooser instead of opening the app — a working fallback, not a failure, but it
   belongs in the deploy runbook.

## Then Phase 8 — Analytics

PART 14's Phase 8 row: all 16 metrics, the analytics endpoints, nightly rollup jobs,
`metric_daily_unit` / `metric_daily_zone` / `metric_section_daily` (migration `0011`), the
dashboards, CSV export, and a BRIN index on `audit_log`.

Two things Phase 7 leaves you that Phase 8 will want:

- **`sumSectionsAcross` / the aggregation rule.** `Σachieved / Σmax`, never the mean of
  percentages (§10.3-C). Phase 7 implements it in `modules/reports/report-payload.ts`; the
  metrics need the same rule, and `packages/domain/src/scoring.ts` already has `sumSections`
  and `rollUpBreakdowns` for it. Do not write a third implementation.
- **Walk-by exclusion.** `ReportZone.scored` is false for a `WALK_BY` and every total skips
  it. PART 11's "walk-by audits are excluded from every score metric" is the same rule; the
  flag to read is `audit.scored`, never `auditType`, and never `status === 'COMPLETED'`
  (R-13b).
