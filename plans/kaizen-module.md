# Plan — Add the Kaizen module to Leanstack (audit5s monorepo)

> The single plan for Kaizen work, read by both devices. Start Claude Code in a checkout of
> the `feat/kaizen` branch and say which device you are (§11).

---

## ⛔ BRANCH RULE: read before anything else

**`feat/kaizen` is the main branch for all Kaizen work.** It lives in the
`team-abassociate/audit5s` GitHub repo, but it is **not** the repo's `main`.

- The repo's **`main` is production.** Every commit on it deploys automatically to the VPS
  that client plants use for 5S. **No Kaizen commit, branch, merge, rebase or PR ever targets
  `main`.** No exceptions, no "small fix", no "just docs".
- **Each device works on its own branch, cut from `feat/kaizen`:**
  - **Device A (krxna): `kaizen/krxna`**
  - **Device B (geetahuja): `kaizen/geetahuja`**

  All commits go to your own device branch, never to the other device's branch, never
  directly to `feat/kaizen`, and never to `main`. Changes reach `feat/kaizen` only through a PR
  **from your device branch, base `feat/kaizen`**. Before `gh pr create`, check that
  `--head kaizen/<you> --base feat/kaizen` is set.
- One PR per build step (or slice of one), titled with the step, e.g.
  `Kaizen step 3: API module`. Merge with a **merge commit** (the repo's existing style),
  never squash or rebase-merge, so your branch and `feat/kaizen` keep the same commits.
- **Keep your branch current by merging, never rebasing:** at the start of every session and
  before every PR, `git fetch origin && git merge origin/feat/kaizen`. Your branch is shared on
  GitHub, so a rebase would need a force-push, which is forbidden. This overrides the
  "rebase on `main`" line in `AGENTS.md`, which is about 5S work.
- The only flow into `main` is **one** PR, `feat/kaizen` → `main`, opened and merged **by the
  owner, by hand, on release day** (§12). No agent opens or merges that PR.
- 5S fixes for clients are a separate track: they go to `main` as before, and are then
  merged *into* `feat/kaizen` (main → feat/kaizen, never the reverse).
- Before every commit and every push, run `git branch --show-current`. If it prints `main`,
  **stop**: do not commit, and tell the owner.
- **Nothing on GitHub blocks a push to `main`.** The owner chose written rules only (this
  section, `CLAUDE.md`, `AGENTS.md`, the device guides). So the branch check before every
  commit and push is mandatory. Agents never change repo settings, and never use
  `--no-verify` or force-push.

---

## 0. Mode and skills — do this before reading any code

1. **Ponytail is on, level full** (`/ponytail full`). Laziest correct solution, reuse before
   writing, shortest diff that keeps the guard chain intact. Never lazy about the rules in §3.
2. All skills below are already installed globally (`~/.claude/skills`, `~/.agents/skills`).
   If one is missing on another machine: `npx skills add <owner/repo>@<skill> -g -y -a claude-code`
   (sources: `emilkowalski/skills`, `mattpocock/skills`, `supabase/agent-skills`,
   `expo/skills`, `pbakaus/impeccable`).
3. Load each skill when its step comes up, not all at once.

**Design rule above every design skill:** `docs/design/GEMBA-BOARD.md` is binding. Several of
these skills recommend rounded corners, soft shadows, semantic platform colours, new fonts or
"bolder" palettes. Where any skill disagrees with GEMBA-BOARD, GEMBA-BOARD wins. Use the
skills for hierarchy, spacing, states, motion, copy, edge cases and craft, never to change
the look.

### Design: Emil Kowalski's full set (`emilkowalski/skills`)

| Skill | Use it for |
|---|---|
| `emil-design-eng` | The craft bar for every new screen: invisible details, press states, polish |
| `apple-design` | Gesture and spring physics, interruptible transitions, restraint (principles only; the look stays GEMBA) |
| `animate-expo` | Building any motion in the field app: module picker, step expand/collapse, press feedback, sheets |
| `animate` | Building any motion in the admin web |
| `find-animation-opportunities` | After each screen exists: where motion helps, and where it doesn't |
| `review-animations` | Reviewing every motion diff before PR |
| `improve-animations` | One audit of Kaizen motion at the end (step 9) |
| `animation-vocabulary` | Naming an effect precisely when writing specs or PR notes |
| `break-ui` | Worst-case data on every Kaizen screen: 200-char themes, ₹ crores, 0 Kaizens, Devanagari, missing photos |
| `mobile-native` | The admin web's corrective-action and Kaizen pages on a phone browser |
| `prototype` | Explicitly invoked only: the module picker and the Kaizen card, two or three variants within GEMBA, then pick one |
| `pick-ui-library` | Explicitly invoked only, and only when a need can't be met by an installed dependency. Every pick is still checked against STACK.md §6 |
| `ask-sonner` | Not used. Admin web has no Sonner; confirmations use the existing `Slip` component |
| `write-swift` | Not used. There is no iOS app (STACK.md §6) |

### Design: other skills

| When | Skill |
|---|---|
| Any new screen, mobile or web | Claude's `frontend-design` (project skill, `audit5s/.claude/skills/frontend-design`) for layout and hierarchy inside GEMBA-BOARD |
| UI critique and polish passes | `impeccable` (pbakaus): run its critique/audit/polish modes on each finished screen |
| Field-app tokens and components | `expo-design-system`: extend the existing `src/lib/gemba.ts` / `theme.ts` / `components/ui.tsx` in their own idiom; also audit for hardcoded colours/spacing drift |
| Field-app motion | `expo-animation`, alongside `animate-expo` |
| Routes and tabs | `expo-router`. Follow the existing `(tabs)/_layout.tsx` role pattern; do not switch to NativeTabs |
| Matching the existing look exactly | project skills `pixel-perfect`, `mobile-design`, `mobile-ui-ux-designer`, `frontend-design` |
| The 11-step Kaizen form | `rampstack-skills:multi-step-form-design`, `rampstack-skills:form-strategy` |
| Admin-web screens | `web-design-guidelines`, `rampstack-skills:accessibility-audit` |

**Motion dependency check:** `react-native-reanimated` and `react-native-gesture-handler`
are **not** in `apps/field-mobile/package.json`. `animate-expo` and `expo-animation` default
to them. Use React Native's built-in `Animated` with `useNativeDriver: true` first. Adding
Reanimated is a native change: it forces a version bump and a new APK, so **stop and ask** before adding it.
Respect reduced motion (see `plans/002-reduced-motion.md`).

### Engineering and architecture

| When | Skill |
|---|---|
| Throughout | `ponytail:ponytail` |
| **Architecture, before step 1** | `domain-modeling` (Kaizen entities, state machine, glossary terms beside Audit; record the decision as R-48), `codebase-design` (module seams: what Kaizen puts in contracts / domain / api / mobile), the built-in **Plan** agent for the step plan |
| Migration, RLS, indexes, triggers | `supabase-postgres-best-practices`, as **plain Postgres advice only**. Supabase itself is not used |
| After step 8 | `improve-codebase-architecture`: logic duplicated between 5S and Kaizen that should be shared, leaks across module boundaries |
| React Native code | `vercel-react-native-skills`, project skill `react-native-expert` |
| Admin-web React code | `vercel-react-best-practices`, `vercel-composition-patterns` |
| OTA vs new build | `eas-update` (channel `production`, `runtimeVersion` policy `appVersion`) |
| Spec and decision record | `rampstack-skills:pm-spec-writing` |
| Ops impact on the VPS | `rampstack-skills:performance-optimization`, `rampstack-skills:backup-and-disaster-recovery`, `rampstack-skills:monitoring-and-alerting` |
| Kaizen Sheet PDF | none: it reuses the 5S report renderer (owner, 2026-10-07: no Excel) |
| Mobile E2E | project skill `maestro` |
| Before every PR | `rampstack-skills:security-baseline`, `security-review`, `code-review high`, `ponytail:ponytail-review`, `simplify` |

The Vercel *coding-guidance* skills (`vercel-react-native-skills`,
`vercel-react-best-practices`, `vercel-composition-patterns`) are required. The Vercel
*hosting* skills (`deploy-to-vercel`, `vercel-cli-with-tokens`, `vercel-optimize`) are
not. `STACK.md` §6 forbids hosting on Vercel or Netlify. Deployment is the existing GHCR → Hostinger VPS pipeline.
`expo-native-ui` is installed but **not used**: it styles to Apple HIG (semantic colours, SF
Symbols), which conflicts with GEMBA-BOARD, and the app is Android-only.

---

## 1. What we are building

**Leanstack** is one product with two modules: **5S Audit** (exists) and **Kaizen** (new).

- One login, one user table, one set of roles, one Postgres database, one API, one APK, one
  admin web, one Hostinger VPS. Kaizen is a **module inside `audit5s`**, not a new repo,
  service, database or app.
- After a successful login (online or offline unlock), the user picks **5S** or
  **Kaizen** on a module picker screen. The choice is remembered on the device. A
  switcher in the profile tab or app header lets them change it without logging out.
- The Kaizen prototype (copied into `docs/requirements/kaizen/` by the first PR, see §11) is **reference only**. Do not
  port its code wholesale. It is a single-file AsyncStorage prototype with plaintext
  passwords. Take only its **field list, workflow, screens and Excel template filling**
  (details in §4). Once the module ships, delete the prototype (§9).

---

## 2. Read first (binding, in this order)

In a checkout of `feat/kaizen`:

1. `AGENTS.md` and `CLAUDE.md`: precedence, rules, and how agents work in parallel.
2. `STACK.md` in full, and `DECISIONS.md` in full (R-1 … R-47).
3. `ARCHITECTURE.md`: **grep for sections, do not read it whole** (225 KB). You need PART 1
   (vocabulary), the authorization matrix, §5 schema conventions, the sync protocol.
4. `docs/design/GEMBA-BOARD.md`, `docs/design/gemba-tokens.css` and
   `docs/design/reference-dashboard.html`, read in full before writing any UI. The copies
   in the old Kaizen folder were identical; use the audit5s ones.
5. `apps/field-mobile/AGENTS.md` and `apps/admin-web/AGENTS.md`.
6. The prototype, for behaviour only:
   `docs/requirements/kaizen/App.js.txt` (screens and workflow), `xlsx.js.txt` (template filling),
   `store.js.txt`, `check-xlsx.mjs.txt`, and `docs/requirements/kaizen/kaizen-sheet-format.xlsx`.

**Where to work.** On Device A, Kaizen work happens in the worktree
`/Users/krxna/main/kaizen` (branch `kaizen/krxna`), never in `/Users/krxna/main/audit5s`.
That checkout is on `main` and holds someone else's uncommitted 5S work. Do not stage, revert
or edit it. **Never open a Kaizen PR against `main`.**

---

## 3. Rules carried over unchanged

Kaizen follows **every** audit5s rule. These are the ones that will be tested:

- **Same stack, same versions.** Expo SDK 57, React Native 0.86.3, React 19.2.3,
  expo-router, expo-sqlite + Drizzle, Zustand + TanStack Query, NestJS 11 on Fastify,
  Node 22, PostgreSQL 18, Drizzle, pg-boss, Zod 4, React 19 + Vite 7 + TanStack Router,
  Tailwind 4. Install mobile packages with `npx expo install`. **Add no dependency that is
  not already in the workspace** unless §4.6 names it.
- **Guard chain** `JwtAuthGuard → PermissionGuard → ScopeGuard` on every Kaizen endpoint.
  Scope resolvers are DI classes. Every Kaizen repository query carries a Unit scope
  predicate. Extend the authorization test suite with a Kaizen block covering IDOR and
  cross-Unit access for each role.
- **RLS policies** on every new table, in the same migration that creates it.
- **Nothing is hard-deleted.** Status changes only. Review history is append-only, enforced
  with `BEFORE UPDATE`/`BEFORE DELETE` triggers like the existing ones.
- **Idempotency keys** on every mutating Kaizen endpoint, through the existing middleware.
- **Media never transits the API.** Before/after photos use the existing `evidence` /
  `media_queue` / presigned-PUT pipeline: client downscale ≤1920px at ~80% JPEG, magic-byte
  check, EXIF strip, SHA-256, content-addressed key. **Owner's decision (2026-10-07):** Kaizen
  photos live in their own `kaizen_photo` table, not in 5S's `evidence` (which belongs to
  audits), so 5S's photo records are untouched. Same pipeline code, different row.
- **Offline-first.** A Zone Leader can draft and submit a Kaizen with no signal. Writes are
  committed per field to SQLite. Submission goes through the existing `outbox`, and the
  sync indicator covers Kaizen items too.
- **Shared types only in `packages/contracts`**: `kaizen.ts` holds enums, Zod schemas and
  sync envelopes. Pure rules (status machine, savings totals, top-3) go in
  `packages/domain/src/kaizen.ts` with ≥90% coverage. Server and client import the same
  functions.
- `timestamptz` in UTC. Money is `numeric(14,2)` rupees, rendered `₹1,08,000` (en-IN).
- **No hosting-provider names** in `apps/` or `packages/`. The CI grep covers `hostinger`.
- **UI from GEMBA-BOARD only.** Zero radius, hard offset shadows (the Android second-View
  trick, never `elevation`), Archivo and DM Mono only, tokens imported and never retyped,
  48px touch targets, primary action at the bottom, status readable without colour, both
  themes. The prototype already follows this, so match its look but build it from the
  audit5s `src/lib/gemba.ts` / `theme.ts` and `components/ui.tsx`.
- **Language.** Every new string goes through the existing language layer
  (`lib/language.ts`, `language-provider.tsx`) with English, Hindi and Marathi entries, and
  Devanagari renders in Noto Sans Devanagari (R-45).

---

## 4. The Kaizen module: specification

### 4.1 Database: same database, same conventions, additive only

"Same schema as audit5S" means: **reuse** `user`, `unit`, `zone`, `unit_membership`,
`role_permission`/`permission`, `device`, `evidence`, `audit_log`, `idempotency_key`,
`notification`, and the pg-boss schema. Kaizen adds only what has no home today, in
**one new migration** after the latest (currently `0043_…`; check `packages/db/migrations`
first), named in the house style (e.g. `0044_a_zone_leader_records_a_kaizen.sql`), with
matching Drizzle schema in `packages/db/src/schema` and a schema test:

- `kaizen`: id (uuid), unit_id, zone_id, author_user_id, `kaizen_no` (server-assigned,
  unique per unit, format `KZ-{ZONECODE}-{NNN}`, e.g. `KZ-Z07-001`, the count running per
  Unit. A device that is offline shows "Number on sync"), machine, line_area, implemented_on (date), team_members, theme, target,
  problem_5w1h, root_cause_4m, analysis_7qc, countermeasure, wastes (enum array),
  parameters (enum array), horizontal_deployment (bool), benefits, annual_saving
  numeric(14,2), idea_by, implemented_by, status, created_at, submitted_at (first
  submission), updated_at. The id itself is device-minted (house style), which is what makes
  sync idempotent, so there is no separate client_id.
- `kaizen_review`: append-only. kaizen_id, reviewer_user_id, decision, comment, created_at.
- Enums from `packages/contracts`:
  - `KAIZEN_STATUSES = ['DRAFT','SUBMITTED','APPROVED','SENT_BACK','REJECTED']`
  - `KAIZEN_WASTES`: Defects, Overproduction, Waiting Time, Non-utilized talent,
    Transportation, Inventory, Motion, Extra-processing (the sheet's order, numbered 1–8)
  - `KAIZEN_PARAMETERS`: Productivity, Quality, Cost, Delivery, Safety, Morale
- `kaizen_photo`: the before/after photos (see §3, Media).
- New permissions `kaizen:create`, `kaizen:read`, `kaizen:review` (house format
  `resource:action`), added to `PERMISSION_MATRIX` in `packages/domain`. The guard reads the
  matrix in code, so no migration row is needed; `seed.ts` mirrors it into `role_permission`.

### 4.2 Roles: existing roles, no new ones

| Role | Kaizen ability |
|---|---|
| ZONE_LEADER | Create, edit DRAFT/SENT_BACK, submit, and see **only their own** Kaizens (owner, 2026-10-07). Tabs: **Overview · New Kaizen · History** |
| COORDINATOR | Review SUBMITTED Kaizens in their Unit (Approve / Send back / Reject; a reason is **required** for Send back and Reject). Tabs: **Overview · Kaizens · My Unit · Analysis** |
| CONSULTANT | Read and analyse Kaizens in assigned Units (R-19/R-28 scoping) |
| SUPER_ADMIN | Everything (R-18) |

State machine in `packages/domain`: `DRAFT→SUBMITTED`, `SUBMITTED→APPROVED|SENT_BACK|REJECTED`,
`SENT_BACK→SUBMITTED`. APPROVED and REJECTED are terminal. Each transition writes
`kaizen_review` and `audit_log` in the same transaction.

**Stop and ask** if any cell in this table conflicts with the authorization matrix in
`ARCHITECTURE.md`.

### 4.3 Field app screens (mirror the prototype's behaviour)

- **Module picker** after login: two large GEMBA tiles, *5S Audit* and *Kaizen*, each
  with a one-line count (open audits / Kaizens awaiting action). The selection is stored with
  the existing secure-storage/theme-choice pattern. Routes: put Kaizen under
  `src/app/kaizen/(tabs)/…` and keep the existing 5S `(tabs)` group untouched.
- **New Kaizen**: the prototype's 11 collapsible steps. Details → Team → Theme → Problem →
  Countermeasure → Before photo → After photo → Waste attacked → Parameters → Horizontal
  deployment → Benefits / saving. Also Root cause [4M], Analysis [7 QC tools], Idea by and
  Implemented by. Keep the same required fields as the prototype. Photos: live capture via
  the existing `camera-capture`, plus gallery through `src/lib/capture/gallery.ts` (the
  sole `expo-image-picker` importer). A Kaizen's "before" photo is often already on the
  phone. Record that as a decision (§8).
- **Detail**: read-only sheet with before/after side by side, status chip, review comment.
  Includes *Edit & resubmit* for SENT_BACK (leader) and the Review section (coordinator).
- **Overview (leader)**: own counts, last-month list. **Overview (coordinator)**: the **KPI card
  (§4.7 A)** first, then the pending queue, then **Top 3 approved by saving** (one yellow slip
  only when a review is waiting).
- **Kaizens (coordinator)**: filter chips All / Pending / Approved / Sent back / Rejected.
- **Analysis**, top to bottom: **KPI card (§4.7 A)**, **Kaizen funnel (§4.7 B)**, **submission /
  completion trend (§4.7 C)**, **Top 5 trend: Departments (§4.7 D)**, then the department-wise /
  zone-wise table with total, approved, pending, returned and approved savings. Bars are meters
  drawn from the ink tokens, never `--accent`.
- **My Unit**: reuse the existing unit/people screens. Do not rebuild them.

### 4.4 Admin web

- After login, the same module switch sits in `AppShell` (a segmented control: 5S | Kaizen).
- Kaizen routes: list with filters, detail with review actions, Analysis. The web Analysis page
  shows the same four §4.7 visuals in a grid (KPI card · funnel · trend on the first row, Top 5
  Departments below), like the reference dashboard. The web Kaizen overview leads with the KPI card. All are scope-filtered
  by the server, with Recharts colours read from tokens. Reuse `EmptyState`, `Status`,
  `Slip`, `SidePanel`, `ui.tsx`.

### 4.5 API

New module `apps/api/src/modules/kaizens/`, shaped like `corrective-actions`:
`GET /api/v1/kaizens` (scoped, filterable), `GET /:id`, `POST` (idempotent, accepts
client_id), `PATCH /:id` (DRAFT/SENT_BACK, author only), `POST /:id/submit`,
`POST /:id/review`, `GET /kaizens/analysis?by=department|zone`, `GET /kaizens/dashboard?period=overall|year|month` (§4.7), `POST /:id/export`.
Extend the sync protocol envelope in `contracts/sync.ts` for Kaizen outbox items rather than
adding a second sync path.

### 4.7 Dashboard visuals (owner's reference images)

The owner supplied reference images in `docs/requirements/kaizen/inspo/`. **Open all five before
building any of these.** `0-full-dashboard.png` is mood only. `1`–`4` are the four components
wanted. **Take the content, structure and behaviour from the images, and the look from
GEMBA-BOARD.** No gradients, no rounded corners, no donut, no blue.

**Owner's decision (2026-10-07), recorded as part of R-48: in the Kaizen module, green means
Approved.** Approved marks use the GEMBA green tokens (`--ok-band` for bar fills, `--ok` for
fills that carry text). Kaizen has no score bands, so the module has no ambiguity. Green stays
reserved for *Approved* and nothing else in Kaizen: no other status, series or decoration
uses it. Tiles are GEMBA tiles: zero
radius, 1.5/2px ink edge, hard offset shadow, Archivo 900 figures, DM Mono labels.

Every number on these visuals comes from **one endpoint**, `GET /kaizens/dashboard?period=…`,
scope-filtered like every other read. The counting rules (what counts as submitted,
approved and so on, and the ratios) are pure functions in `packages/domain/src/kaizen.ts`,
tested, and used by the API only. The client renders what it receives and computes nothing.
DRAFT Kaizens are never counted anywhere: they haven't been submitted.

**Phone constraint:** the field app has **no chart or SVG library**, and adding
`react-native-svg` is a native change (new APK on every client phone). Build the phone
versions from plain `View`s as described below. If something truly cannot be drawn that way,
**stop and ask**. Do not add the library. The admin web uses Recharts (already installed) or
hand-authored SVG, with colours read from the tokens.

**A. KPI card** (`1-kpi-card.png`). Coordinator Overview (phone + web) and top of Analysis.
- A 2-column × 3-row grid of figures separated by 1px `--edge-soft` hairlines, inside one tile,
  with an **Overall · Year · Month** segmented control (selection uses `--accent`, as all
  selection does).
- Figures (reference label → ours):
  | Reference | Ours | Rule |
  |---|---|---|
  | Submitted ideas | **Submitted** | every Kaizen ever submitted in the period (any status but DRAFT) |
  | Fresh ideas | **Awaiting review** | status SUBMITTED |
  | In progress | **Sent back** | status SENT_BACK (being reworked by the author) |
  | Rejected ideas | **Rejected** | status REJECTED |
  | Rejection ratio | **Rejection ratio** | rejected ÷ submitted |
  | Acceptance ratio | **Acceptance ratio** | approved ÷ submitted |
- Ratios show as a percentage with **one decimal, truncated, never rounded up** (R-45). With 0
  submitted, a ratio is an em dash `—`, never `0 %`.
- Figures: Archivo 900, tabular, `letter-spacing:-.04em`. Labels: DM Mono, uppercase, `--ink-2`.

**B. Kaizen funnel** (`2-kaizen-funnel.png`). Analysis. **Stage size follows the numbers.**
- Stages, each a subset of the one above, so the funnel always narrows:
  1. **Submitted** (all non-DRAFT)
  2. **Reviewed** (has at least one review decision: approved, sent back or rejected, now or before)
  3. **Approved**
  4. **Approved with a saving** (approved and `annual_saving > 0`)
- Each stage's width = its count ÷ stage-1 count × the full width, with a minimum width so its
  label (count, Archivo 900, plus stage name) still fits. A zero stage shows its label at the
  minimum width, never vanishing. Each stage also shows **% of Submitted** in DM Mono.
- Shape: **web**, SVG trapezoids, where each stage's top edge is its own width and its bottom
  edge is the next stage's width (the reference shape). **Phone**, centred stacked bars of the
  same widths (a stepped funnel), with no SVG.
- Fills: Submitted `--edge-soft`, Reviewed `--ink-3`, then the two Approved stages in green:
  Approved `--ok-band`, Approved with a saving `--ok`. This matches the reference, whose last
  stage is green. Text on each stage uses whichever of `--ink` / `--tile` meets 4.5:1 **in that
  theme** (dark mode's `--ok` is a light green). Check both themes.
- **Stages are confirmed by the owner**: Submitted → Reviewed → Approved → Approved with a saving.
- Same **Overall · Month · Year** control as the KPI card.
- Width changes animate when the period changes: the `--motion` duration, ease-out,
  interruptible, and none under reduced motion (`animate-expo` / `animate` skills).

**C. Submission / completion trend** (`3-submission-completion-trend.png`). Analysis.
- Grouped vertical bars, one pair per month, **last 6 calendar months** including the current
  one. Left bar = **Submitted** that month, right bar = **Approved** that month (by
  review date). The title reads "KAIZEN SUBMISSION / COMPLETION TREND", and the two title
  words act as the legend, styled like their bars.
- Bars: Submitted = `--edge-soft` fill with a 1px `--ink-3` outline; Approved = solid
  `--ok-band` (green, as in the reference).
  Square tops. Y axis starts at 0, integer ticks only, axis labels in `--ink-3` DM Mono.
- A month with no Kaizens shows empty bars at 0 with its label kept, never a gap in the axis.

**D. Top 5 trend: Departments** (`4-top5-trend-departments.png`, with **"Locations" renamed
"Departments"**). Analysis.
- Title "TOP 5 TREND – DEPARTMENTS", with a **Submitted | Approved** toggle (the reference's
  "Completed kaizens" is our Approved).
- The 5 departments with the most Kaizens in the last 6 months under the active toggle. Grouped
  bars per month for the same 6 months as C, one bar per department, with a legend underneath.
  Fewer than 5 departments → show what there is. None → the honest empty state.
- Telling 5 series apart **without colour** (GEMBA: colour is semantic only): five ink-scale
  fills (`--ink`, `--ink-2`, `--ink-3`, `--edge-soft`, `--tape`) **plus** a pattern on
  alternate series (solid / `.gb-na`-style hatch / outline), so the chart reads in sunlight
  and in greyscale. The legend swatches repeat fill + pattern.
- "Department" is the Kaizen's Zone's `zone.department_hint`, the field 5S already has. It is
  optional free text, so group by its trimmed, case-folded value, display the most common
  spelling, and put Zones without one under **"No department"** (it can be in the top 5 like any
  other). If spellings visibly split one department in real data, tell the owner rather than
  adding a department table.

**Phone layout:** all four stack full-width in the order A, B, C, D. Charts C and D scroll
horizontally **inside their own container** if the 6 months don't fit (GEMBA §6). The page
itself never scrolls sideways. Tapping a bar shows its exact count in a small tile (no hover
on phones). **Web:** hover and focus show the same tooltip.

**Done means:** each visual passes `break-ui` (0 Kaizens, 1 Kaizen, 10,000 Kaizens, a
department name 60 characters long, Devanagari names, all-rejected, all-approved), light and
dark, English and Hindi, and the GEMBA acceptance checklist.

### 4.6 Export (the Kaizen Sheet, as a PDF)

- **Owner, 2026-10-07: a redesigned sheet, no Excel.** The export is a one-page A4 PDF in the
  "A3 Reimagined" theme (`apps/api/assets/kaizen-sheet.css`, colour-coded Plan / Do / Check /
  Act), not the client's `.xlsx` filled in. `docs/requirements/kaizen/kaizen-sheet-format.xlsx`
  stays as the reference for which fields the sheet carries.
- The downloaded file is named `{Unit name} - Zone {n} {Zone name} - {date}.pdf` (owner, 2026-10-07).
- `POST /:id/export` enqueues `kaizen.export` and returns 202 with an `exportId`;
  `GET /:id/export/:exportId` answers QUEUED / READY / FAILED, and once READY carries a
  short-TTL presigned GET. The job id is the export id, so there is no export table.
- It prints in `worker-report`, the one process with Chromium, on its own queue at
  concurrency 1 and on the same browser as the 5S reports, so neither waits for the other.
  Same rules as the 5S PDF: no network at render, fonts (Archivo, IBM Plex Mono, OFL) and
  photos embedded.

---

## 5. App versions, builds and deployment (follow audit5s exactly)

- Field app: `apps/field-mobile/app.config.ts`, name **Leanstack**, package
  `in.abassociate.audit5s`, Expo owner `abassociates`, EAS project
  `71411439-1202-4ffe-bf53-55ef490216e7`, `runtimeVersion: { policy: 'appVersion' }`,
  Android only, arm64-only production APK under 30 MB.
- **Phone updates are automatic, and nobody publishes one by hand.** When a release reaches
  `main`, `.github/workflows/deploy.yml` first deploys the server (`publish-and-deploy`), then
  its `field-app-update` job publishes an OTA update to the `production` channel, but only if
  the release changed `apps/field-mobile`, `packages/contracts`, `packages/domain` or
  `pnpm-lock.yaml`, **and** `scripts/native-changed.mjs` finds the native layer unchanged since
  `apps/field-mobile/native-baseline.txt` (Leanstack 0.1.0, versionCode 15). So:
  - **Never run `eas update --channel production` or `eas build --profile vps` by hand.** Neither
    device does, ever. Releases go through the pipeline only.
  - **The Kaizen module must add no native module** (camera, image-picker, sqlite and
    secure-store already exist). Then the release reaches phones over the air, with no reinstall.
  - **If a native change ever looks necessary, stop and ask the owner before writing it.** It
    turns the release into a new APK that every client phone must install (`version` bump,
    `eas build --profile vps`, a new `native-baseline.txt`). That is a client-facing event, and
    it is the owner's call.
  - Before every Device B PR, run `node apps/field-mobile/scripts/native-changed.mjs` the way
    `deploy.yml` does, or at minimum confirm that `apps/field-mobile/package.json`,
    `app.config.ts`, `plugins/` and `pnpm-lock.yaml` gained no native package or plugin.
- Backend: no new container and no new service. The Kaizen module ships inside the existing
  `api` / `worker-general` images through `.github/workflows/ci.yml` → `deploy.yml` →
  `infra/deploy.sh` on the same Hostinger VPS, and the migration runs through the existing
  `db:migrate` path. Check that `mem_limit`s still fit (STACK §9) and stop and ask if not.
- Local dev: `pnpm dev:up`, `pnpm db:migrate`, `pnpm seed` (macOS can use `./dev.sh up`). Docker names the stack `audit5s` in every folder, so all checkouts on one machine share **one** local database. The additive Kaizen migrations do no harm to a 5S checkout using it. Extend `seed.ts` with a handful
  of Kaizens across statuses for the existing seed Unit.

---

## 6. Build order (one PR per step, device branch → `feat/kaizen`; merge `origin/feat/kaizen` into your branch before each)

1. `contracts/kaizen.ts` + migration + Drizzle schema + RLS + triggers + schema test.
   (Contracts is the contention point, so land this alone and first.)
2. `domain/kaizen.ts`: state machine, totals, top-3. Tests at 90% coverage.
3. API module + authorization tests + idempotency + review transaction test.
4. Mobile: module picker + SQLite tables + outbox/sync wiring + offline unlock still works.
5. Mobile: leader screens (New / History / Overview), photos via the evidence pipeline.
6. Mobile: coordinator screens (Kaizens / Review / Analysis / Overview).
7. Kaizen Sheet PDF export + download.
8. Admin web: module switch + Kaizen list/detail/review/analysis.
9. Docs, Maestro flow, cleanup (§8, §9).

---

## 7. Definition of done

- `pnpm typecheck && pnpm lint && pnpm test` green; API e2e (`test:e2e`) green; CI under its
  current time.
- Authorization suite covers Kaizen for all four roles, including cross-Unit IDOR.
- A Maestro flow passes on a device: log in as Zone Leader → pick Kaizen → create a Kaizen
  in airplane mode with two photos → reconnect → it syncs and gets a number → log in as
  Coordinator → send it back with a reason → leader resubmits → coordinator approves → it
  appears in Top 3 → the exported PDF shows its ticks and photos in place.
- Switching 5S ↔ Kaizen keeps the session. The 5S module behaves exactly as before
  (no regressions in its tests).
- The GEMBA-BOARD acceptance checklist passes on every new screen, in light and dark,
  English and Hindi.
- `break-ui` pass done on the Kaizen card, detail and analysis table.

---

## 8. Documentation to update (same PRs, not later)

- `DECISIONS.md`: add **R-48: Leanstack hosts two modules, 5S and Kaizen**. Include the
  owner's ruling that green means Approved inside the Kaizen module (§4.7). It covers the
  module picker, the Kaizen roles, the gallery allowance for Kaizen photos, server-assigned
  Kaizen numbers, and the export renderer choice.
- `ARCHITECTURE.md`: a Kaizen section (entities, state machine, endpoints, sync items).
  Add the section only; do not restructure the file.
- `README.md` / `AGENTS.md`: one line each saying the repo is Leanstack (5S + Kaizen).
  Do **not** rename packages, the repo, the Android package or the EAS slug. Renaming
  breaks installed APKs and signing.

## 9. Cleanup

After step 7 is merged and the export is verified against the client's sheet, **ask the
owner for confirmation**, then:
- delete `docs/requirements/kaizen/*.txt` (the prototype code; the workbook stays), and
- nothing else. The original Kaizen folder was already retired when this plan was committed.

## 10. Stop and ask (do not guess)

- Should every role see the Kaizen module, or only some Units/users? (Default: everyone with
  Unit access.)
- Should Kaizen numbering be per Unit or per Zone? (Default: per Unit, with the zone code
  prefix.)
- Should approved savings feed the existing analytics rollups (`metric_daily_*`)? (Default:
  no, Kaizen analysis is computed live until it measurably needs a rollup.)
- Anything from the STACK.md §6 "do not add" table, RAM below ~4 GB, or an authorization
  cell that reads ambiguously.

---

## 11. Two devices, two Claude accounts: who owns what

The work is split across two machines. **Git is the only shared state.** Neither session
sees the other's conversation, memory or local files. Everything the other side needs must
be in a merged PR, a PR description, or this file (committed at `plans/kaizen-module.md`).

**Setup already done (commit that added this file):** the `feat/kaizen` branch was created
from `main` (after PR #90, `4147924`), with the worktree at `/Users/krxna/main/kaizen` on Device A.
It has **no upstream**, so a bare `git push` can't reach `main`. The prototype and the client's
Kaizen Sheet are in `docs/requirements/kaizen/`, and the branch rule is at the top of `CLAUDE.md`,
`AGENTS.md` and `plans/README.md`.

**Still to do, by the owner:** publish both shared branches, from the worktree:
`git push origin feat/kaizen kaizen/krxna` (each to its own name; never `main`).
Device A's branch `kaizen/krxna` already exists locally, cut from `feat/kaizen`.

**Device B, first time:** `git fetch origin && git switch -c kaizen/geetahuja origin/feat/kaizen
&& git push -u origin kaizen/geetahuja`, then read this file. After that, `git push` from
`kaizen/geetahuja` goes only to `kaizen/geetahuja`.

From then on, `plans/kaizen-module.md` on `feat/kaizen` is the copy both devices read. A change
to the plan is a PR to that file, never an edit on one machine only.

**Start every session by saying which device you are:** "I am Device A (backend)" or
"I am Device B (mobile)". Stay in your lane.

| | Device A: backend + web | Device B: field app |
|---|---|---|
| Owns exclusively | `packages/contracts`, `packages/db` (all migrations), `packages/domain`, `apps/api`, `apps/admin-web`, `seed.ts`, `DECISIONS.md`, `ARCHITECTURE.md` | `apps/field-mobile` (incl. `app.config.ts` version, `eas.json`), `.maestro/` flows |
| Build steps | 1, 2, 3, 7, 8, and docs in 9 | 4, 5, 6, and Maestro in 9 |
| Merges PRs into `feat/kaizen` | Yes: reviews and merges **every** PR into `feat/kaizen`, both devices' | Never merges anything. Opens PRs and asks Device A to review them |
| Releases | Merges `feat/kaizen` → `main` on release day only (§12). That merge deploys the server and then, automatically, the phone update | Never publishes a phone update or builds an APK (§5) |

**Order:**

1. **Phase 0 (Device A alone): steps 1 + 2.** Contracts, migration and domain merged to `feat/kaizen`.
   Device B meanwhile: setup (below), then the `prototype` skill on the module picker and the
   Kaizen card (two or three GEMBA variants), and pick one. No code merged yet.
2. **Phase 1 (parallel).** Device A: step 3 (API) **first**, then 7 (export), then 8 (admin
   web). Device B: step 4 (module picker, SQLite tables, outbox entries), then 5 and 6, built
   against the merged contracts. Wire real sync once A's step-3 PR is on `feat/kaizen`.
3. **Phase 2.** B runs the Maestro end-to-end flow against a local stack on `feat/kaizen`. A writes
   R-48 and the ARCHITECTURE section. **Ship order: backend deployed and healthy first, then
   B publishes the OTA update/APK.** An app calling endpoints the VPS doesn't have yet is
   the failure this prevents.

**Rules for the split:**
- Device B needs a contract change? Do not edit `packages/contracts`. Open a GitHub issue or
  draft PR describing it; Device A makes it. Same for migrations. Two people writing
  migrations means two `0044_…` files.
- Device A commits only on `kaizen/krxna`, and Device B only on `kaizen/geetahuja`. PRs go from
  the device branch into `feat/kaizen`, never `main`. Merge `origin/feat/kaizen` into your branch
  at the start of every session and before opening a PR (no rebase, no force-push).
- Need something from the other device before their PR is merged? Wait for the merge into
  `feat/kaizen`. Never merge or cherry-pick from the other device's branch.
- Each PR description ends with a **"For the other device"** line: what changed that they
  depend on (new endpoint, renamed field, new enum value), or "nothing".
- Both devices run the full stack locally (`pnpm dev:up && pnpm db:migrate && pnpm seed`).
  Nobody develops against the production VPS.

**Per-device setup (both machines):**
- **Optional, owner's choice: a pre-push guard.** Agents do not install it. From inside
  the cloned repo:
  ```bash
  hook="$(git rev-parse --git-common-dir)/hooks/pre-push"
  cat > "$hook" <<'HOOK'
  #!/bin/sh
  # Kaizen rule: nothing is ever pushed to main from this machine. main deploys to clients.
  while read local_ref local_sha remote_ref remote_sha; do
    if [ "$remote_ref" = "refs/heads/main" ]; then
      echo "BLOCKED: pushing to main is not allowed. Kaizen work goes to feat/kaizen." >&2
      exit 1
    fi
  done
  HOOK
  chmod +x "$hook"
  ```
  Test it: `git push origin HEAD:main --dry-run` must print `BLOCKED`. The hook covers all
  worktrees of the clone. Release day uses the GitHub PR button, which the hook does not
  affect.
- Both machines already run audit5s: GitHub push access, Node 22, pnpm 10, Docker, a local
  `.env`, and (Device B) Android testing. **No `.env` is sent between machines.** Each machine
  uses its own development `.env`. Never use the server's production `.env`
  (`/opt/audit5s/.env` on the VPS) on a laptop.
- Each machine works in a **separate Kaizen folder** (a git worktree) next to its existing
  `audit5s` folder: `kaizen`. A worktree shares the repo but **not** its untracked
  files, so the Kaizen folder needs its own `pnpm install` and a copy of `.env` from the
  `audit5s` folder (see the device prompts in `plans/kaizen-device-a.md` / `plans/kaizen-device-b.md`).
- Same plugins: in Claude Code run `/plugin marketplace add DietrichGebert/ponytail`,
  `/plugin marketplace add rampstackco/claude-skills`, then `/plugin install ponytail@ponytail`
  and `/plugin install rampstack-skills@rampstack`. The project skills in `.claude/skills/`
  come with the clone.
- Same skills installed:
  `npx skills add emilkowalski/skills -g -y -a claude-code`,
  `npx skills add mattpocock/skills -s domain-modeling -s codebase-design -s improve-codebase-architecture -g -y -a claude-code`,
  `npx skills add supabase/agent-skills -s supabase-postgres-best-practices -g -y -a claude-code`,
  `npx skills add expo/skills -s expo-design-system -s expo-animation -s expo-router -s eas-update -g -y -a claude-code`,
  `npx skills add pbakaus/impeccable -g -y -a claude-code`,
  `npx skills add vercel-labs/agent-skills -g -y -a claude-code`.

---

## 12. Production safety: the 5S module is live with clients

The 5S module is in daily use in client plants. **Nothing in this work may change how 5S
behaves, and nothing reaches production until a planned release.**

### Why there is an integration branch
`.github/workflows/deploy.yml` deploys **every green commit on `main`** to the VPS,
including running migrations on the live database. So:

- All Kaizen work merges into `feat/kaizen`. CI runs there (it runs on every branch), and
  nothing deploys.
- 5S fixes keep going to `main` as usual. Device A merges `main` into `feat/kaizen` at least
  weekly, and immediately after any 5S hotfix, so the final merge is small.
- `feat/kaizen` merges into `main` **once**, on release day, by the owner.

### Rules that protect 5S while building
- **Migrations are additive only.** New tables, new enum values, new permission rows, new
  indexes. Never alter, rename or drop an existing column, constraint, trigger or enum value,
  and never rewrite existing rows. That way the previous release still runs on the new
  schema, which is what makes a backend rollback safe.
- **Shared code touches are listed.** Every PR that edits a file outside the Kaizen folders
  (login flow, sync envelope, evidence pipeline, outbox, tab layout, guards) says so in a
  **"Touches 5S"** section of the PR description. The owner reviews those PRs personally.
- **Every existing test stays green.** The API, authorization, domain, db and mobile suites,
  plus the 5S Maestro flows. Never delete or loosen a 5S test to make a Kaizen PR pass.
- **The phone's local database upgrades in place.** New SQLite tables only. Write a test
  that installs today's production build, queues offline 5S audits with photos, upgrades to
  the Kaizen build and syncs. **Zero queued 5S items may be lost.**
- **Kaizen export runs at concurrency 1 in `worker-report`** (its own queue, the 5S
  reports' browser) and must not delay 5S report jobs. Check the container memory ceilings (STACK §9) with a Kaizen export and a 5S report
  rendering at the same time.

### Release rehearsal (before release day)
1. On the VPS, restore the latest backup into a scratch database the way
   `infra/restore-drill.sh` does (never the production volume). Run the Kaizen migrations
   against it. They must apply cleanly, and the 5S smoke checks (`apps/admin-web/smoke*.mjs`)
   must pass against an API pointed at it. Do not copy client data to laptops.
2. Device B runs the field app from `feat/kaizen` against a local stack, on the emulator **and**
   on a real Android phone (the way Device B already tests 5S on a phone), for at least two
   working days. That means 5S audits end to end and Kaizen end to end, including offline, and
   the upgrade test from §12 (queued 5S items survive). No production server is involved:
   Kaizen endpoints don't exist there until release.
3. Run `node apps/field-mobile/scripts/native-changed.mjs` against the baseline commit. It must
   exit 0. If it exits 3, stop: the release would need a new APK (§5).
4. Write the rollback plan into the release PR: the last good `main` SHA, and the current
   production OTA update group ID (from expo.dev, project `audit5s-field`).

### Release day
1. Pick a time when clients are not auditing (agree it with them), and tell them.
2. Take a fresh pgBackRest backup and confirm it completed.
3. The owner merges `feat/kaizen` → `main`. The pipeline then does everything in order: CI,
   server deploy and health checks, and **then** the automatic OTA update to every phone. The
   `field-app-update` job runs only after the server deploy succeeds. Watch both jobs go green
   in GitHub Actions.
4. Check 5S immediately on production: log in, open an audit, submit a response, and view
   a report. Then check Kaizen. Phones pick the update up on their next launch.
5. Watch Sentry for the next hour.

### Rollback
- **Backend:** re-run *Production deploy* (`workflow_dispatch`) with the last good SHA. The
  additive migration means the old code runs fine with the new tables present. Do not try
  to reverse the migration.
- **Field app:** republish the previous update group to `production` (`eas-update` skill).
  Phones fall back to the previous JS on next launch, and their queued data is untouched.
- **Data:** restoring from backup is the last resort and needs the owner's decision. It
  loses everything clients entered since the backup.

### Stop and ask
- Any change that cannot be made additively.
- Any failing 5S test whose fix is not obvious.
- Anything that would need a new APK (native change) rather than an OTA update. That means
  every client phone must reinstall, which is a client-facing event.
