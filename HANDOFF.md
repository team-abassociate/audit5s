# Handoff prompt — implement the 5S Audit Management Platform

> Paste this file (or reference it with `@HANDOFF.md`) as the opening message of a Claude Code
> session in the `team-abassociate/audit5s` repository, branch `claude/Krishna`.

---

You are a Principal Engineer taking over the `audit5s` repository to **build the product**. The
architecture phase is finished and approved; your job is implementation, phase by phase, exactly
as specified in `ARCHITECTURE.md` PART 14 — starting at Phase 1 and not stopping until each phase's
acceptance criteria are met and its tests are green.

Do not re-design. Do not re-open decisions. Where the sources below disagree, the order of
precedence is fixed and stated in §2. Anything that is genuinely not answered by the sources is an
open question to raise, not a gap to fill with invention (see §7).

## 1. Read these files first, in this order

| File | What it is | How to treat it |
| --- | --- | --- |
| `STACK.md` | The Stack Decision Record: every technology choice, the six containers on one Hostinger VPS, Cloudflare R2/Pages/Tunnel, the "do not add" table, the host do-not-touch list, the 12-step build order, operational tripwires. | **Binding on every technology name.** Its §5 rules are non-negotiable. |
| `DECISIONS.md` | Resolutions R-1 … R-5: document precedence, pg-boss as the only enqueue mechanism, scope-resolver enforcement, no encryption at rest on mobile, evidence redaction. | **Binding tie-breaker.** R-5's trigger carve-out and R-3a's index ship in the *first* migration. |
| `ARCHITECTURE.md` | The approved blueprint: domain model, DB schema, authorization matrix, state machines, REST API, offline sync protocol, reporting pipeline, analytics, security, repo layout, 9-phase roadmap, tests, production checklist. Its body has been swept to match `STACK.md`; the change record sits at the top. | **Binding on every behaviour.** PART 1 settles vocabulary and every contradiction; PART 5 + PART 8 are the implementation contract; PART 9 is the mobile contract; PART 14 is your work plan. |
| `docs/requirements/architecture-brief.md` | The business brief `ARCHITECTURE.md` was written against (roles, modules, invariants, deliverables). | Authoritative on intent where `ARCHITECTURE.md` is silent. Its technology list is superseded by `STACK.md`. |
| `docs/requirements/brainstorm.md` | The original stakeholder narrative: screens, tabs, button names, audit flow, photo rules, report wishes. Rambling and internally inconsistent by design. | Use for **UI copy, screen order and field-level behaviour**; never for architecture. Where it contradicts the files above, they win (`ARCHITECTURE.md` §1.3 C1–C10). |
| `docs/requirements/5S_lean_audit_data_1.xlsx` | The real department checklist workbook. | **Seed-data truth** for checklist templates. Layout in §3.4 below. |
| `docs/requirements/sample-zone-report.pdf` | The Zone report the business already issues by hand (Sahney Kirkwood, Zone 1 — Press). | **Visual truth** for the `INITIAL_ZONE` / `AFTER_EVIDENCE_ZONE` PDFs. Match it; extend it per §4. |
| `docs/requirements/sample-summary-report.pdf` | The multi-zone summary the business already issues (22 zones). | **Visual truth** for the `MULTI_ZONE_SUMMARY` PDF. Match it; extend it per §4. |
| `README.md`, `docs/requirements/README.md` | Repo front page and the requirements index. | Keep them current as you add apps and packages. |

`ARCHITECTURE.md` was written **before** the workbook and the two sample PDFs were available (see
its "A note on inputs" and assumptions A1–A6 in §1.6). §3 of this document closes that gap with
facts taken from the real files. Those facts are binding and supersede the placeholders in
`ARCHITECTURE.md` §1.6 and §11.6.

## 2. Order of precedence

1. `STACK.md` on any **technology name**; `ARCHITECTURE.md` on any **behaviour**; `DECISIONS.md`
   breaks ties (R-1).
2. This handoff, §3–§7 — only where it records a fact from the real source files that the
   documents above left as a placeholder.
3. `docs/requirements/architecture-brief.md`.
4. `docs/requirements/brainstorm.md`.
5. The sample PDFs and the workbook are data and styling truth, not architecture.

Canonical role names are `SUPER_ADMIN`, `CONSULTANT`, `COORDINATOR`, `ZONE_LEADER`. The word
`ADMIN` must not appear as a role anywhere (`ARCHITECTURE.md` N2).

## 3. Facts from the real source files (resolve A1–A6)

### 3.1 A1 — question count: **confirmed**

Every department sheet has exactly 5 sections × 10 questions = 50, numbered globally 1–50.
`questions_per_section = 10`, `total_questions = 50`. No configuration change needed.

### 3.2 A2 — departments: **resolved**

Nine checklist templates, one per workbook sheet, in this order:

| Sheet name (= template `name`) | `code` |
| --- | --- |
| Shop Floor | `SHOP_FLOOR` |
| Office | `OFFICE` |
| Stores (RM) | `STORES_RM` |
| Production | `PRODUCTION` |
| FG Stores | `FG_STORES` |
| Packing Area | `PACKING_AREA` |
| Boiler & Utility | `BOILER_UTILITY` |
| Maintenance | `MAINTENANCE` |
| Premises | `PREMISES` |

The first three sheets — `5S Audit Team`, `Audit Schedule`, `Monthly Zone Scores` — are **not**
checklists. The importer must skip them (rule: a sheet is a checklist only if cell `A1` matches
`^5S AUDIT CHECK SHEET – (.+)$`).

### 3.3 A3 — rating scale and colours: **corrected**

The sample reports use a four-band scale with these exact boundaries, labels and colours.

| Band token | Range | Label | Colour | Tint (table cells) |
| --- | --- | --- | --- | --- |
| `band-outstanding` | ≥ 90 % | Outstanding | `#1B7F4B` (green) | `#E2F4E9` |
| `band-on-track` | 75 – 89.99 % | On Track | `#2A7097` (blue) | `#E2EEF7` |
| `band-improving` | 60 – 74.99 % | Improving | `#BE7D0F` (amber) | `#FDF3DB` |
| `band-needs-support` | < 60 % | Needs Support | `#B3261E` (red) | `#FCE7E5` |

Note the third boundary is **60**, not 50 as in the placeholder, and the labels differ.

Response chips / report response text:

| Response | Label | Colour |
| --- | --- | --- |
| `SCORE_2` | Well implemented | `#1B7F4B` |
| `SCORE_1` | Progressing well | `#BE7D0F` |
| `SCORE_0` | Needs improvement | `#B3261E` |
| `NA` | Not applicable | neutral grey |

Brand tokens (report header, tables, radar): maroon `#5C1816` (header band, table header rows,
section rows, radar polygon stroke), orange accent `#F46A00` ("5S" badge, achieved/max labels on
the radar), table border `#E8D7D1`, alternating row tints `#FFFAF7` / `#FFF7F3`, radar fill
maroon at low alpha.

**Where it lives.** `ARCHITECTURE.md` §11.6 still names `packages/config/rating-scale.ts`, but
`packages/config` no longer exists in the PART 13 layout. The file is
`packages/domain/src/rating-scale.ts`: `percentage → band` is a scoring rule, and `domain` is
already imported by API, web and mobile. It exports `RATING_BANDS`, `RESPONSE_TOKENS`,
`BRAND_TOKENS` and `bandFor(pct: number | null)`. Nothing else in the codebase hard-codes a
colour. Fix the §11.6 path in Phase 0.

### 3.4 A4 — workbook layout: **corrected** (this changes the import profile)

The workbook is **not** a flat one-row-per-question table. `ChecklistImportProfile` must
implement a *sheet-per-department, section-header-row* layout:

```
Row 1   A1 = "5S AUDIT CHECK SHEET – {DEPARTMENT}"           (merged A:E)   → template name
Row 2   A="Company:"  C="Audit Date:"  E="Scoring: Yes = 2 marks, No = 0 marks. Max score = 100."
Row 3   A="Area / Dept.:"  B={department or blank}  C="Auditor Name:"
Row 4   A="Shift:"  C="Auditee / Area Owner:"
Row 6   header: Sr. | Check Point | Yes / No | Marks | Remarks / Observations
Row 7   "1S – SEIRI (SORT)"                                   (merged A:E)   → section S1_SORT
Rows 8–17   Sr 1..10  | question text | (blank) | 0 | (blank)
Row 18  "Sub-total 1S (out of 20)"                                            → skip
Row 19  "2S – SEITON (SET IN ORDER)"                                          → S2_SET_IN_ORDER
Rows 20–29  Sr 11..20
Row 30  "Sub-total 2S (out of 20)"
Row 31  "3S – SEISO (SHINE)"                                                  → S3_SHINE
Rows 32–41  Sr 21..30
Row 42  "Sub-total 3S (out of 20)"
Row 43  "4S – SEIKETSU (STANDARDIZE)"                                         → S4_STANDARDIZE
Rows 44–53  Sr 31..40
Row 54  "Sub-total 4S (out of 20)"
Row 55  "5S – SHITSUKE (SUSTAIN)"                                             → S5_SUSTAIN
Rows 56–65  Sr 41..50
Row 66  "Sub-total 5S (out of 20)"
Rows 67–74  TOTAL SCORE / PERCENTAGE / RATING / rating-scale note / signatures / "Prepared by AB Associates, Nashik."  → skip
```

Parsing rules:

- Detect a section by regex `^([1-5])S\s*[–—-]\s*(SEIRI|SEITON|SEISO|SEIKETSU|SHITSUKE)` on
  column A (normalise en/em dash and hyphen). Do not rely on fixed row numbers — rows may shift.
- A question row is one whose column A is an integer and whose column B is non-empty.
- `order_in_section` = position within the current section (1–10); `global_order` = the `Sr.`
  value. Validate both agree, and that `Sr.` is contiguous 1–50 across the sheet.
- Section display labels used by the reports are exactly: `1S – SEIRI (SORT)`,
  `2S – SEITON (SET IN ORDER)`, `3S – SEISO (SHINE)`, `4S – SEIKETSU (STANDARDIZE)`,
  `5S – SHITSUKE (SUSTAIN)`. The `s_section → label` mapping lives in `packages/domain`.
- The sheet's "Yes = 2 / No = 0" scoring note is **legacy**. The application scale is
  `2 / 1 / 0 / NA` per `ARCHITECTURE.md` D3 (the sample zone PDF already uses it). Do not import
  the "Marks" or "Yes / No" columns.
- `Area / Dept.` (B3) mirrors the sheet name on most sheets and is blank on `Office`; the sheet
  name is authoritative.

All six pipeline stages in `ARCHITECTURE.md` §8.5 apply unchanged; only the PARSE stage's column
mapping is affected. The import runs in `worker-general` (`STACK.md` §7 step 6).

### 3.5 A5 — report page: **confirmed with specifics**

A4 portrait, English. Maroon header band (`#5C1816`) with an orange rounded "5S" badge at left,
the title in white ("LEAN 5S — ZONE REPORT" / "LEAN 5S SUMMARY REPORT") with a one-line
subtitle beneath ("Zone-wise assessment" / "Cumulative performance across the selected zones"),
and the **AB Associates – Operations Consulting** logo in a white card at the right. Footer on
every page: left `Lean 5S Report • AB Associates`, right `Page N`. The logo asset and the shared
header/footer layout live with the report templates in
`apps/api/src/modules/reports/templates/`.

### 3.6 A6 — precision: **confirmed**

Percentages render with one decimal (`75.0%`), marks as `achieved / max` integers.

## 4. Report layouts — what the samples show, and what to add

Reproduce the sample layout first, then append the elements `ARCHITECTURE.md` §10.3 requires
that the hand-made samples lack. Nothing in the samples is optional.

Rendering constraint (`STACK.md` §5): templates are React → HTML → CSS `@page`, rendered by
`worker-report`, and must stay **free of JavaScript-dependent layout**. The radar chart and the
comparison bars are therefore **server-computed inline SVG**, not a client chart library.

### 4.1 Zone report (`INITIAL_ZONE`) — from `sample-zone-report.pdf`

1. **Header band** (§3.5).
2. **Metadata grid**, 3 columns × 3 rows, small grey caps labels over bold values:
   `COMPANY / UNIT · DEPARTMENT · ZONE` / `AUDIT DATE · AUDITOR NAME · ZONE LEADER` /
   `MARKS (75 / 100) · PERCENTAGE (75.0%) · RATING (On Track)`.
   Zone renders as `Zone {code} — {name}` (e.g. `Zone 1 — Press`), from the `AuditZone` snapshots.
3. **S-WISE SCORING** table: `S | ACHIEVED | MAX | PERCENTAGE`, five rows using the section labels
   in §3.4; percentage coloured by band. A fully-NA section prints `N/A` (D4).
4. **5S PERFORMANCE WEB**: pentagon radar, axes labelled `1S…5S` with `achieved/max` under each in
   orange; polygon plotted on **percentage**; caption "Each S shows achieved marks / applicable
   maximum; polygon uses percentage." To its left, an **AUDITOR VERIFICATION** box containing the
   auditor selfie.
5. **RATING SCALE** row of four coloured pills: `≥ 90% Outstanding`, `75–89% On Track`,
   `60–74% Improving`, `< 60% Needs Support`.
6. **CHECKLIST — RESPONSES AND MARKS** table: `Sr. | Check Point | Response | Marks`. Each section
   begins with a maroon header row carrying its subtotal (`15 / 20`). Response text is the label
   from §3.3, coloured. Marks column shows `2 / 1 / 0 / NA`.
   → **Add**: the optional per-question remark as a second, smaller line under the question text.
7. **ZONE TOTAL** row (`75 / 100`, `75.0%`) then the footnote: *"NA is excluded from the
   applicable maximum. After-improvement evidence is managed separately and does not change
   these marks."*
8. → **Add** after the checklist, in this order (`ARCHITECTURE.md` §10.3-A):
   - **ZONE REMARK** block (only if present).
   - **GOOD EVIDENCE**: photos two per row, side by side, captioned `Q{n} · {S label} · Score 2`
     plus the optional photo remark. Green tick badge.
   - **NONCONFORMITIES**: one row per photo, photo **left-aligned in the left half**, right half a
     light placeholder frame with **no text**; caption `Q{n} · {S label} · Score {0|1}` and remark;
     yellow warning badge (exclamation in a filled yellow rectangle, per brainstorm);
     a **"View / Submit Corrective Action"** button linking to the signed `/ca/$token` route.
   - Images: long edge ≤ 1920 px on capture, embedded at print quality (not thumbnails), fetched
     by the worker through short-TTL presigned GETs; paper-friendly spacing — no page-per-photo.

### 4.2 After-evidence report (`AFTER_EVIDENCE_ZONE`)

Identical to 4.1, new snapshot version, with GOOD evidence **unchanged** and each nonconformity's
right half filled by either `AFTER PHOTO + submitted by + description + ✓ Verified` or
`NOT POSSIBLE + explanation`, or `Pending` with the deadline. Add the closure-summary block
(`ARCHITECTURE.md` §10.3-B). A redacted photo (R-5) renders as its placeholder with the caption
"Photo removed".

### 4.3 Summary report (`MULTI_ZONE_SUMMARY`) — from `sample-summary-report.pdf`

1. Header band.
2. Metadata grid: `COMPANY / UNIT · AUDIT DATE · AUDITOR NAME` / `MARKS (1280 / 2092) ·
   PERCENTAGE (61.2%) · RATING (Improving)` / `ZONES SUMMARISED (22)`.
   When the selected zones span several audits or auditors, show a date range and a
   comma-separated auditor list — do not silently pick one.
3. **S-WISE SCORING** table with **summed** achieved and **summed applicable max** across the
   selected zones (`234 / 422 = 55.5%`). The overall percentage is `Σachieved / Σmax`
   (`1280 / 2092 = 61.2%`), **never** an average of zone percentages. This is the
   `ARCHITECTURE.md` §10.3-C aggregation rule; the sample confirms it.
4. **5S PERFORMANCE WEB — ALL SELECTED ZONES** radar with the summed `achieved/max` per axis.
5. Rating scale pills.
6. **ZONE-WISE MARKS PER S** table: `ZONE | DEPARTMENT | 1S | 2S | 3S | 4S | 5S | TOTAL | %`.
   Each S cell is `a/b` and is **tinted by its own band**; TOTAL is `a / b`; `%` tinted by band.
   Final maroon row `ALL SELECTED ZONES · N zone(s) · sums · total · %`.
7. **ZONE SCORE COMPARISON**: horizontal bar per zone, bar and percentage coloured by band, in
   zone order.
8. Footnote: *"Cell colours follow the rating scale: green ≥ 90% Outstanding, blue 75–89% On
   Track, amber 60–74% Improving, red < 60% Needs Support. NA answers are excluded from the
   applicable maximum."*
9. → **Add** (`ARCHITECTURE.md` §10.3-C): highest-/lowest-performing lists with the dominant weak
   S, score-band histogram, **flagged photos** (one GOOD + one NONCONFORMITY per zone, only where
   flagged, with remarks), and the nonconformity summary. **No auditor selfie** in the summary.

The "interactive dropdowns inside the PDF" wish in `brainstorm.md` is settled by
`ARCHITECTURE.md` C6/N8: the PDF is static; interactivity lives on the web route.

## 5. How to work

### 5.1 Phase 0 — reconcile the blueprint (one commit, before any code)

1. `ARCHITECTURE.md` §1.6: mark A1, A5, A6 confirmed; rewrite A2, A3, A4 with §3 above.
   §11.6: replace the placeholder `RATING_BANDS` with §3.3 and correct the file path to
   `packages/domain/src/rating-scale.ts`. §8.5 PARSE: add one paragraph describing the
   sheet-per-department profile. "A note on inputs": the source files are now in
   `docs/requirements/`; remove the sentence saying they were unavailable.
2. `DECISIONS.md`: append **R-6 — Source-file reconciliation**, summarising §3 (departments,
   rating scale, import layout, token file location) so the tie-breaker file records it.
3. `README.md` status → "Implementation in progress — see HANDOFF.md".

### 5.2 Then Phases 1 → 9, strictly in order

`ARCHITECTURE.md` PART 14 phases are the delivery units; `STACK.md` §7 is the dependency order
inside them. Concretely, Phase 1 executes `STACK.md` steps 1–5 in that order (contracts + db with
RLS and append-only triggers → domain → API skeleton with the guard chain, authorization suite,
idempotency middleware and the pg-boss rollback test → auth → Unit/Zone/membership CRUD), Phase 2
executes step 6, and so on. Infrastructure (`bootstrap.sh`, `docker-compose.yml`, pgBackRest → R2,
the backup-age alarm) is set up alongside step 3, not at the end.

For each phase:

- Build every row — backend, web, mobile, migrations, tests. A phase is not done when the
  backend is done.
- Write the tests the phase names; they must pass locally before the commit.
- Verify the **Acceptance** row literally, and say in your report how you verified it.
- Scaffold exactly as `ARCHITECTURE.md` PART 13: `apps/{api,admin-web,field-mobile}`,
  `packages/{contracts,domain,db}`, `infra/`, pnpm workspaces, **no Turborepo**.
- Scoring, state machines, login-ID generation, evidence classification, geofence distance, the
  rating scale and the `s_section → label` mapping live **only** in `packages/domain` (pure,
  zero I/O). Every type that crosses an app boundary lives **only** in `packages/contracts`.
- **Seed** is a fourth entrypoint of the API image, `apps/api/src/seed.ts` (`node dist/seed`),
  run through the Nest application context so it uses the real services: a Super Admin from
  `SEED_SUPER_ADMIN_*` env vars, the permission matrix from PART 6, and **the nine checklist
  templates imported through the real import pipeline** from
  `docs/requirements/5S_lean_audit_data_1.xlsx`, each published as v1. The seed is the first
  integration test of the importer.
- Local development: `docker-compose.yml` is the six production services. A
  `docker-compose.dev.yml` override may run Postgres 18 and an S3-compatible stand-in
  (MinIO) because `R2_ENDPOINT` is an env var; that is a dev convenience, not a new production
  dependency, and nothing in `apps/` or `packages/` may reference it by name.

### 5.3 Non-negotiable rules while coding

From `STACK.md` §5–§6 and `DECISIONS.md`, restated because they are the ones most often broken:

- Global guard chain `JwtAuthGuard → PermissionGuard → ScopeGuard`; opting out is explicit and
  justified. Scope resolvers are DI classes, unit-tested against fakes. RLS policies from day
  one. The authorization-matrix harness with its completeness check ships in Phase 1.
- Append-only tables are enforced by `BEFORE UPDATE` / `BEFORE DELETE` triggers that raise, with
  R-5's three-column carve-out on `evidence` written **in the first migration**. No `DELETE` verb
  for `Audit`, `AuditZone`, `QuestionResponse`, post-completion `Evidence`, `CorrectiveAction`,
  `ReportSnapshot`, `AuditLog` (D8).
- pg-boss is the only queue and the only enqueue mechanism, enqueued **inside** the domain
  transaction; the rollback test is permanent. **No Redis**, no outbox table, no dispatcher.
- Media never transits the API: presigned PUT after a scope check, presigned GET ≤ 5 min, magic-
  byte validation, EXIF strip, SHA-256, content-addressed keys. No public buckets.
- `response_value` is an enum; `NA` is excluded from denominators; an all-NA section is `null`,
  rendered `N/A`, excluded from parents (D3/D4). Server recomputes every score (D5).
- Historical `AuditZone` rows carry snapshots; editing a Zone never changes history (D6).
- Phone number is a **bootstrap** password only: Argon2id-hashed, `must_reset_password = true`,
  72-hour expiry, per-login-ID lockout in `login_attempt` (CH-1). Never log or return it.
- Mobile: UI → SQLite (Drizzle, sqlite dialect) → outbox → API; the questionnaire never awaits
  the network; commit per question response; client UUIDv7 keys; `Idempotency-Key` on every
  mutating call. Plain `expo-sqlite`, no SQLCipher (R-4). Android first; no iOS work.
- Nothing from the `STACK.md` §6 "do not add" table without asking; nothing from the OCI
  do-not-touch list ever (CI greps for it).
- Match existing code style once it exists; keep comments sparse and factual.

### 5.4 Git

- Work on `claude/Krishna`. Push with `git push -u origin claude/Krishna`.
- One commit per coherent step (Phase 0; then per-phase scaffolding, backend, web, mobile,
  tests). Descriptive messages. Run lint, typecheck and the affected tests before every commit.
- Migrations are files in git under `packages/db/migrations`, applied by CI — never
  `drizzle-kit push` against a shared database. One environment.
- Do not open a pull request unless asked.

### 5.5 Report back at the end of every phase

State: what was built (by track), which tests ran and their result (verbatim failures if any),
how the acceptance row was verified, what is left in the phase, and any open question from §7.
Do not claim a phase complete with a failing or skipped test.

## 6. Definition of done for the whole handoff

All nine phases' acceptance rows pass; `ARCHITECTURE.md` §16.14 go-live gates are green; the
three report kinds render from fixtures byte-stably and visually match §4; the nine templates
import from the real workbook with zero errors; a full offline three-zone audit syncs cleanly;
the five-nonconformity partial-submission scenario (§7.3 / Phase 6) passes end to end; the
pg-boss rollback test and the M-1 unique-violation test are in the suite and green.

## 7. Open questions — escalate, do not invent

Ask the user when you first need the answer; proceed with the stated default meanwhile.

| # | Question | Default until answered |
| --- | --- | --- |
| Q1 | Firebase project for FCM (service-account credentials). | `PushChannel` adapter with a console/log implementation; in-app notifications fully working. WhatsApp/SMS stay interfaces only (`STACK.md`). |
| Q2 | Hostinger and Cloudflare account access, R2 bucket names, tunnel credentials, GHCR token — needed at `STACK.md` step 3 for `bootstrap.sh` and `deploy.yml`. | Write both against env vars and document every required secret in `infra/README.md`; do not stub a fake provider. |
| Q3 | Does the business accept the bootstrap-password-with-forced-reset recommendation (CH-1), or insist on the permanent phone-number password? | Bootstrap + forced reset (the adopted recommendation). |
| Q4 | Initial Super Admin identity (name, phone, email) for the seed. | Read from env; fail loudly if unset. |
| Q5 | Organization logo as a vector or high-resolution file (the PDFs embed a raster copy). | Extract the logo from `sample-zone-report.pdf` as a placeholder and flag it. |
| Q6 | Summary report "AUDIT DATE / AUDITOR NAME" when selected zones span multiple audits. | Date range + auditor list (§4.3). |
| Q7 | Whether the legacy sheets (`5S Audit Team`, `Audit Schedule`, `Monthly Zone Scores`) should ever be imported. | Skipped; the platform replaces them (analytics, assignments, Zone master data). |
| Q8 | Retention period and data-fiduciary contact for evidence photos (R-5, A12). | 7 years, contact `TBD` — both flagged in `docs/runbooks/privacy.md`. |

Begin with Phase 0.
