# Phase 5 handoff — what is done, what is left

> Continues `HANDOFF.md`, which still governs: its §2 precedence order, §5.3 coding rules and
> §7 open questions are unchanged. Read that first if you have not.

Branch `claude/Krishna`, head `91fe48e`. Phases 0–4 complete; **Phase 5 backend, migrations
and tests complete**; Phase 5 web, mobile and the acceptance row **not started**.

---

## 1. Where the Phase 5 table stands

`ARCHITECTURE.md` PART 14, Phase 5 row, line by line.

| Track | State |
| --- | --- |
| **Backend** | **Done.** See §2. |
| **Web** | **Not started.** Evidence gallery per audit/zone, classification filters, flagged indicators, full-size viewer. |
| **Mobile** | **Not started.** The walk-by flow, evidence preview/delete before completion, flag toggles. |
| **Migrations** | **Done** — `0008_walk_by_and_media.sql`. The next number is **0009**. |
| **Tests** | **Done** — all four the row names. See §2.4. |
| **Acceptance** | **Not verified.** It is an offline test and depends on the mobile flow existing. See §5. |

---

## 2. What the backend commit did (`91fe48e`)

Read `DECISIONS.md` **R-12 (a–f)** before changing any of it; it records why each choice is
what it is, and the alternatives that were rejected.

### 2.1 Walk-by has no questionnaire and no score

* `packages/domain/src/audit-type.ts` — `isScoredAuditType`, `auditTypeUsesChecklist`,
  `auditTypeRequiresZonePhoto`. **This is the single copy of §2.7's "no questionnaire, no
  score".** Phase 8's "walk-by excluded from score metrics" should import
  `isScoredAuditType` rather than write `auditType <> 'WALK_BY'` in SQL.
* `scoring.service.ts` now has the `WALK_BY` branch: `summarise` returns `scored`, and
  `recompute` writes **nothing** for a walk-by — not even zeros. An
  `audit_zone_section_score` row for a walk-by is a score that does not exist.
* `Audit.scored` and `AuditScoreSummary.scored` are new response fields. All-zero totals
  with a `null` percentage are otherwise indistinguishable from a scored audit nobody has
  answered, and the difference matters: one will have a score, the other never will.

### 2.2 §2.7 steps 3 and 4, and the audit-level photo guard

* `upsertAuditZoneRequestSchema` gained `zoneDescription` and `zoneLeaderUserId` — the one
  place a client supplies a D6 snapshot, honoured on a walk-by and ignored on a scored
  audit. Taken on the **first** write only, like every other snapshot.
* A selected leader must hold an ACTIVE `ZONE_LEADER` membership in the audit's Unit, or
  the request is `422`.
* `audits.service.ts` `complete()` enforces §7.1's "walk-by zones each have ≥1 photo". Not
  implied by the Zone guard: finish a Zone with its one photo, then delete that photo (E-4
  permits it while the audit is `IN_PROGRESS`), and the audit would otherwise complete
  carrying a Zone that observed nothing.

### 2.3 The media worker

* `apps/api/src/modules/evidence/media.worker.ts`, queue `media.process`, registered by
  `worker-general` only — §12.8 keeps image decoding out of the API process.
* The enqueue is **inside** `commit`'s transaction (R-2), via
  `EvidenceRepository.markCommittedAndEnqueueMedia`.
* The EXIF strip is `stripImageMetadata` in `packages/domain/src/image-metadata.ts`:
  **pure, structural, no decode**. A clean photograph comes back byte-identical. A bare
  JFIF `APP0` is kept as structure — every encoder emits one, and stripping it would
  rewrite every photograph in the system and make `stored_checksum_sha256` non-null
  always, destroying the one thing it reports.
* Thumbnails use **`jimp`** (new dependency; pure JS, no native toolchain, no per-platform
  binary on the `linux/arm64` image). R-12b records the trigger for switching to `sharp`.
* `readImageDimensions` reads the header so an oversized decode is refused **before** a
  bitmap is allocated — §12.8's decompression-bomb control, at 24 MP.

### 2.4 The four tests the row names

| Named test | Where |
| --- | --- |
| Walk-by completion with zero photos → `409` | `evidence.e2e.test.ts` (Phase 4) |
| Two GOOD flags in a zone → `409` | `evidence.e2e.test.ts` (Phase 4) |
| …**and the DB constraint holds under a concurrent race** | `evidence.e2e.test.ts` — **new**, four concurrent `PATCH`es, exactly one wins |
| Delete after completion → `409` | `evidence.e2e.test.ts` (Phase 4) |
| Response 2→0 flips GOOD→NONCONFORMITY | `evidence.e2e.test.ts` (Phase 4) |

New suites: `walk-by.e2e.test.ts` (19 tests — §2.7's ten steps, the no-questionnaire
constraints, the score exclusion, the audit-level guard, the classification patch, the
gallery, the thumbnail variant) and `media-worker.e2e.test.ts` (14 tests). Plus
`packages/db/src/walk-by-schema.test.ts` for 0008's database guarantees.

### 2.5 Migration 0008 — read this before writing 0009

1. A CHECK on `audit` and a trigger on `audit_zone`: a walk-by pins no checklist version.
2. A trigger on `question_response`: an answer needs its Zone's pinned version (QR-2).
3. `evidence.media_processed_at` and `evidence.stored_checksum_sha256`.
4. **R-10's append-only trigger is dropped and recreated with a six-name carve-out**
   (R-5's three redaction columns plus the worker's three). If Phase 6 or 7 needs another
   evidence column writable after completion, that is another `DROP`/`CREATE TRIGGER` in a
   new migration — never an edit to 0007 or 0008.
5. `app_zone_leader_name(unit_id, user_id)` — see §3.

---

## 3. One bug fixed on the way, worth knowing about

`zone_leader_name_snapshot` was **silently `NULL`** on every audit Zone a Consultant added,
and `zone.zoneLeaderName` was null in every catalogue a device cached. PART 6 gives a
Consultant `own_record` on `user:read`, so `user_select` admits their own row and no other,
and a `LEFT JOIN "user"` for the leader's name therefore yielded null rather than an error.

Fixed **without loosening `user_select`** — that would contradict PART 6 and hand out a
user record to get at a display string. 0008 adds a narrow `SECURITY DEFINER` function
returning the display name alone, for an ACTIVE `ZONE_LEADER` of the named Unit, and only
inside the caller's own Units. `zones.repository.ts` and `audits.repository.ts` read
through it; the `users` join is gone from both.

This matters for Phase 7: the Zone report's `ZONE LEADER` metadata field (`HANDOFF.md`
§4.1 item 2) reads that snapshot, and it would have printed blank.

---

## 4. What to build next

### 4.1 Mobile — the walk-by flow (`apps/field-mobile`)

The flow is **selfie → zone → description → leader → camera → ≥1 photo → optional extras →
remarks → save → next/finish**, and it must work offline through the existing outbox, not a
second path. There is no walk-by route yet; `src/app/` has `audit/`, `checklist/` and
`unit/`.

Reuse, do not rebuild:

* `src/components/camera-capture.tsx` is the **only** importer of `expo-camera` in the
  workspace (R-11). Reuse it; do not add a second capture path.
* `src/lib/db/evidence.repository.ts` already has `captureLocalEvidence` (which moves a
  walk-by Zone off `DRAFT` on the first photograph), `deleteLocalEvidence`,
  `setLocalSummaryFlag` with local E-3/one-per-Zone enforcement, and
  `zoneHasLocalEvidence` for the completion gate.
* `src/lib/db/audit.repository.ts` has `createLocalAudit`, `addLocalZone`,
  `completeLocalZone`, `completeLocalAudit`.

**Two concrete changes the backend commit now requires:**

1. **`setLocalSummaryFlag` currently enqueues `evidence:upsert` on the *media* queue**
   (`evidence.repository.ts`). That re-runs `upload-intent`, which §8.7 makes idempotent on
   the id — it returns the existing intent untouched — so **the flag never reaches the
   server**. It must enqueue **`evidence:patch`** on the **data** queue with
   `{ isSummaryFlagged }`. The operation exists server-side now (`sync-batch.service.ts`),
   sorts after `commit` and before every `complete`, and `'patch'` must be added to
   `OUTBOX_OPERATIONS` in `src/lib/db/schema.ts`. No local migration is needed — the
   outbox `operation` column is `TEXT`.
2. A re-judged walk-by classification needs the same `evidence:patch` item with
   `{ classification }`. `reclassifyLocalEvidence` covers only the E-2 question-evidence
   case.

`addLocalZone` should pass `zoneDescription` and `zoneLeaderUserId` through to its
`audit_zone:upsert` payload. The local `audit_zone` snapshot columns already exist.

`npx expo export --platform android` is a fast way to prove imports resolve.

### 4.2 Web — the evidence gallery (`apps/admin-web`)

Per audit and per zone, classification filters, flagged indicators, a full-size viewer
through a presigned GET. The endpoints are ready:

* `GET /audits/:auditId/evidence` — **new**; `?auditZoneId=&classification=&kind=&summaryFlaggedOnly=&includeDeleted=` plus cursor paging.
* `GET /audit-zones/:auditZoneId/evidence` — the per-Zone listing.
* `GET /evidence/:id/view-url?variant=thumbnail|original` — **the variant is new.** Use
  `thumbnail` for tiles (PART 16: "originals fetched only on demand") and `original` for
  the viewer. A row whose thumbnail has not been produced yet falls back to the original,
  so there is no broken-image state to design for.
* `Evidence.mediaProcessedAt` is `null` while the media job is queued or retrying.

`AuditDetailPanel.tsx` is where the gallery belongs, and it should branch on
`audit.scored` — a walk-by has no S-wise table and no radar to render.

### 4.3 The acceptance row

> A walk-by audit over three Zones with one photo each completes offline and syncs; a
> fourth Zone with no photo cannot be completed; exactly one GOOD and one NONCONFORMITY
> photo can be flagged per Zone.

Write it as `apps/api/test/acceptance-phase5.e2e.test.ts` in the **shape
`acceptance-phase4.e2e.test.ts` established**: import the real device repositories and the
real `runSync` engine from `apps/field-mobile`, and keep the module-level `offline` flag
that makes every HTTP call throw, so "offline" is enforced by the test rather than claimed.
The fourth-Zone half is the interesting one — it must fail on the *device* (local
`zoneHasLocalEvidence` gate) **and** be refused by the server if pushed anyway.

### 4.4 Docs and the browser walkthrough

* **`smoke-audit.mjs`** — extend it. A walk-by through the live API, the gallery rendering
  in a browser, and a flagged photograph. Note the README's own caveat: it needs a freshly
  seeded database (it rotates the bootstrap credential) and an admin bundle built with a
  matching `VITE_API_BASE_URL` when the API is not same-origin.
* **`README.md`** — the Phase 5 row still says "Next".
* **`ARCHITECTURE.md`** — the change record at the top, as Phases 0–4 did. §8.7 gained the
  audit-wide gallery and the `variant` parameter; §5.6 gained two columns.

---

## 5. Environment notes

* Docker Hub is 403 under this session's egress policy. Use local PostgreSQL 16
  (`sudo service postgresql start`), create the roles from `infra/sql/00-roles.sql`, and
  two databases (`audit5s`, `audit5s_test`) owned by `audit5s_owner`. **Production and CI
  are pinned to 18**; nothing in 0008 relies on 16 behaviour (one CHECK, three plain
  plpgsql triggers, one SQL function, no new types).
* Migrations are checksummed once applied. Editing an applied file fails the runner — drop
  and recreate the dev databases instead.
* `pnpm install` leaves `argon2` and `@swc/core` build scripts unapproved and everything
  still works; do not "fix" it.

## 6. Verification at `91fe48e`

`pnpm lint`, `pnpm -r build`, `pnpm -r typecheck` clean. **459 unit tests** (264 domain,
112 db, 46 mobile, 37 api) and **427 API e2e tests** pass — up from 420 and 393 — including
the authorization-matrix completeness check, which the new gallery route has an entry for.

## 7. Open questions

Unchanged from `HANDOFF.md` §7. **Q2** (Oracle/Cloudflare credentials), **Q5** (vector
logo) and **Q8** (retention period, data-fiduciary contact) are still unanswered; proceed
on the stated defaults and escalate rather than inventing. **Q1** stands on its default
(`ConsolePushChannel`). Q5 and Q8 both come due in Phase 7.
