# Decision record — resolutions R-1 … R-6

Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`STACK.md`](./STACK.md), the
Stack Decision Record (the engineering handoff).

These resolutions settle points where the two source documents disagreed or were silent.
They are **binding** and carry the same weight as the decisions in `ARCHITECTURE.md` §1.4.
Where a resolution changes something in `ARCHITECTURE.md`, the affected section is named.

| # | Subject | Status |
| --- | --- | --- |
| R-1 | Document precedence | Settled |
| R-2 | Job enqueue mechanism | Settled |
| R-3 | Scope resolver enforcement | Settled |
| R-4 | Mobile local storage encryption | Settled |
| R-5 | Evidence redaction | Settled — **build before the append-only triggers ship** |
| R-6 | Source-file reconciliation | Settled |

---

## R-1 — Document precedence

**`STACK.md` wins on any technology name. `ARCHITECTURE.md` wins on any behaviour.**

This replaces the topic split in `STACK.md` §10 ("infrastructure → handoff, domain →
`ARCHITECTURE.md`"), which
could not be applied cleanly because several rules in `ARCHITECTURE.md` are stated in terms of
a specific technology.

The complete list of superseded technology choices is the **Superseded technology choices**
table at the top of `ARCHITECTURE.md`. Anything not on that table stands as written.

Both documents are now in the repository, so the rule resolves without outside context:
`STACK.md` is the stack, `ARCHITECTURE.md` is the design, this file is the tie-breaker.

One consequence worth stating separately, because it is a rule rather than a name:
`ARCHITECTURE.md` §6.1 rule **AZ-1** is restated as —

> No repository method may execute without a scope predicate. A base repository requires an
> explicit `ScopeContext` argument, and a lint rule forbids constructing a Drizzle query
> outside a repository class.

The intent of AZ-1 is unchanged; only the ORM it names is.

---

## R-2 — Job enqueue: pg-boss only

**pg-boss is the only enqueue mechanism.** The `domain_event` transactional-outbox table
(`ARCHITECTURE.md` §5.9) is **removed** from the schema, and the "transactional outbox
dispatcher" line item in the Phase 6 roadmap (§14) is removed with it.

Rationale: pg-boss stores its jobs in the same PostgreSQL database as the domain writes, so a
second outbox table and dispatcher would be a duplicate mechanism doing one job.

**Verification required at build step 3.** The guarantee this depends on is that a job
enqueued inside a domain transaction does not become visible to workers if that transaction
rolls back. The test is one assertion:

```
BEGIN → enqueue job → ROLLBACK → assert no worker ever receives the job
```

This test goes in the API skeleton's suite and stays there permanently. If it cannot be made
to pass with the pinned pg-boss version, that is a finding to raise — not a reason to
silently reintroduce a second mechanism.

---

## R-3 — Scope resolver enforcement

`ARCHITECTURE.md` §6.2's `own_unit` resolver uses `LIMIT 1` against `unit_membership`. This is
deterministic **because of** invariant M-1 (§5.2), which permits a `COORDINATOR` or
`ZONE_LEADER` at most one `ACTIVE` membership, and `own_unit` is used only by those two roles.

Two requirements follow.

**R-3a — the invariant must be migrated, not just documented.** The partial unique index

```sql
CREATE UNIQUE INDEX unit_membership_one_active_admin
  ON unit_membership (user_id)
  WHERE status = 'ACTIVE' AND role IN ('COORDINATOR','ZONE_LEADER');
```

ships in the **first** migration, and the authorization suite contains a test that inserts a
second `ACTIVE` membership for a Coordinator and asserts a unique violation. An invariant that
exists only in prose is not an invariant, and every `own_unit` predicate depends on this one.

**R-3b — the `assigned_actions` widening is intentional.** The resolver reads

```
corrective_action.assigned_zone_leader_user_id = :actor OR corrective_action.unit_id = :actorUnit
```

The `OR` clause means **any Zone Leader of a Unit may act on any corrective action belonging to
that Unit**, not only those assigned to them. This is deliberate: assigned leaders take leave,
and corrective actions must not stall. Do not "fix" it. If it is ever narrowed, that is a
product decision requiring a replacement for the stall case.

---

## R-4 — Mobile local storage is not encrypted at rest

SQLCipher is **not** used. The mobile local database is plain `expo-sqlite`. This supersedes
the SQLCipher line item in the Phase 4 roadmap (`ARCHITECTURE.md` §14).

Unchanged by this decision, and still required: credentials and the offline unlock verifier
live in the OS keystore (`expo-secure-store`), never in SQLite; and local rows are deleted once
the server confirms the corresponding server-side row is committed, on the same rule that
already governs local media files.

---

## R-5 — Evidence redaction

Evidence photos contain identifiable people. `ARCHITECTURE.md` §12 already records that a
retention policy, a lawful basis and a subject-access/erasure process are required before
go-live. Invariant E-4 (§5.6) blocks evidence deletion after audit completion, and D8 (§1.4)
forbids hard deletion outright. Redaction is how both hold at once.

**Erasure is redaction, never deletion.** The R2 object is overwritten with a placeholder; the
row, its `checksum_sha256` and the audit trail survive, and the record states plainly that a
photo was present and was removed.

**Schema.** `evidence` gains three columns:

| Column | Type | Notes |
| --- | --- | --- |
| `redacted_at` | `timestamptz` NULL | Set when the object has been overwritten |
| `redacted_by_user_id` | `uuid` FK→`user.id` NULL | Super Admin only |
| `redaction_reason` | `text` NULL | Free text; recorded in `audit_log` as `evidence.redacted` |

**Trigger exception.** The append-only `BEFORE UPDATE` trigger on `evidence` must permit an
update whose only changed columns are these three. **This exception is carved when the trigger
is first written, in build step 1** — not later. Once the trigger is live over real audit data,
altering it becomes a migration nobody wants to run.

**Also required before go-live**, and cheap now:

- A consent line on the mobile capture screen stating that photos may include people and are
  retained as audit records.
- The retention period from assumption A12 (evidence originals ≥ 7 years) written down as
  stated policy rather than an S3 lifecycle side effect.
- A named data-fiduciary contact.

**Not built now:** no erasure request queue, no admin UI, no self-service flow. A Super Admin
endpoint plus the schema above is the whole scope. The workflow comes when someone asks.

---

## R-6 — Source-file reconciliation

`ARCHITECTURE.md` was written before the department workbook and the two sample report PDFs
were available; its assumptions A1–A6 stood in for them. All three files are now in
`docs/requirements/`, `HANDOFF.md` §3–§4 reconciles the blueprint against them, and
`ARCHITECTURE.md` §1.6, §8.5 and §11.6 have been rewritten to match. This entry records the
outcome so the tie-breaker file carries it.

**Every fact below was verified against the real files**, not carried over on trust.

### R-6a — Nine departments, from the sheet names

One `ChecklistTemplate` per workbook sheet, in workbook order:

| Template `name` (= sheet name) | `code` |
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

The workbook's first three sheets — `5S Audit Team`, `Audit Schedule`, `Monthly Zone Scores` —
are legacy planning sheets. They are **not** imported, and the platform replaces them
(analytics, assignments and Zone master data respectively). A sheet is a checklist only if its
cell `A1` matches `^5S AUDIT CHECK SHEET [–—-] (.+)$`.

A1 is confirmed unchanged: every sheet is exactly 5 sections × 10 questions, numbered globally
1–50.

### R-6b — The rating scale is four bands at 90 / 75 / 60

| Band token | Range | Label | Colour | Tint |
| --- | --- | --- | --- | --- |
| `band-outstanding` | ≥ 90 % | Outstanding | `#1B7F4B` | `#E2F4E9` |
| `band-on-track` | 75 – 89.99 % | On Track | `#2A7097` | `#E2EEF7` |
| `band-improving` | 60 – 74.99 % | Improving | `#BE7D0F` | `#FDF3DB` |
| `band-needs-support` | < 60 % | Needs Support | `#B3261E` | `#FCE7E5` |

The placeholder in `ARCHITECTURE.md` §11.6 had the wrong labels and put the third boundary at
50. Response colours are `SCORE_2` `#1B7F4B` "Well implemented", `SCORE_1` `#BE7D0F`
"Progressing well", `SCORE_0` `#B3261E` "Needs improvement", `NA` neutral grey. Brand tokens:
maroon `#5C1816`, orange `#F46A00`, table border `#E8D7D1`, row tints `#FFFAF7` / `#FFF7F3`.

The sample reports contain no `NA` row, so the neutral grey is the one value here that is a
house choice rather than a measurement; it is marked as such in the token file.

### R-6c — The tokens live in `packages/domain`

`ARCHITECTURE.md` §11.6 named `packages/config/rating-scale.ts`, but `packages/config` does not
exist in the PART 13 layout. The file is **`packages/domain/src/rating-scale.ts`**:
`percentage → band` is a scoring rule, and `domain` is already imported by the API, the web app
and the mobile app. It exports `RATING_BANDS`, `RESPONSE_TOKENS`, `BRAND_TOKENS` and
`bandFor(pct: number | null)`, where `null` (a fully-`NA` section, D4) is not a band. Nothing
else in the codebase hard-codes a colour.

### R-6d — The import profile is sheet-per-department

The workbook is not a flat one-row-per-question table. `ChecklistImportProfile` implements a
sheet-per-department, section-header-row layout: a merged section header above each block of
ten questions, a sub-total row after each block, and trailing total / percentage / rating /
signature rows that are skipped. Sections are detected by regex on column A, never by row
number. The sheet's `Yes / No` and `Marks` columns are legacy and are not imported — the
application scale is `2 / 1 / 0 / NA` (D3). The parse rules are written out in
`ARCHITECTURE.md` §8.5.

**This changes the PARSE stage's column mapping only.** The six-stage pipeline and the commit
semantics are unchanged, which is what A4 predicted would happen. VALIDATE gains one row-level
check that the corrected layout makes checkable — that `Sr.` runs contiguously 1–50 across a
sheet and agrees with each question's position in its section.

### R-6e — Precedence

These facts sit at precedence level 2 (`HANDOFF.md` §2): above the business brief and the
brainstorm, below `STACK.md` on technology names and `ARCHITECTURE.md` on behaviour. They
supersede the placeholders they replace and nothing else. The workbook and the sample PDFs are
data and styling truth, never architecture.

---

## R-7 — What building the importer against the real workbook settled

`R-6` recorded the facts the workbook revealed. Implementing the import against it surfaced two
consequences that the documents leave implicit; both are recorded here rather than decided
again in a later phase.

### R-7a — One import job, many sheets

`ARCHITECTURE.md` §5.4 gives `checklist_import_job` a single `template_id` and a single
`committed_version_id`, which reads as one job per checklist. The real file is **nine
department sheets in one workbook** (R-6a), the seed imports all nine through the pipeline
(`HANDOFF.md` §5.2), and §8.5's PARSE stage says "read sheets" in the plural. One job per
sheet would mean uploading the same file nine times.

So a job fans out to **`checklist_import_sheet`**, one row per detected sheet, carrying that
sheet's content hash, its duplicate verdict and the version it committed.
`checklist_version.source_import_job_id` — which §5.4 already defines as "provenance back to
the Excel file" — remains the link in the other direction. `checklist_import_row` gains a
`sheet_id`, so a row-level error names the sheet as well as the row.

Nothing else about the pipeline changes: the six stages, the dry-run guarantee (nothing is
written to `checklist_version` before COMMIT) and the per-sheet commit transaction are exactly
as §8.5 describes them.

### R-7b — VALIDATE normalizes whitespace and smart quotes, and nothing else

§8.5 stage 3 auto-normalizes "trailing whitespace / smart quotes". Read more broadly — to
include en and em dashes — it rewrites the business's own wording: the workbook punctuates with
en dashes throughout ("Shop floor is clean – free of dust", "retrieval within 2–3 minutes"), so
normalising them produced fifteen warnings on a file with nothing wrong with it, and would have
stored questions the auditor never wrote.

Normalisation is therefore exactly two rules: collapse whitespace, and straighten curly quotes.
Dashes are content. The section labels keep their en dash for the same reason (R-6d), and the
end-to-end suite asserts that the real workbook imports with **zero** errors and **zero**
warnings — which is the assertion that would have caught this.

---

## R-8 — What building the audit engine settled

`R-7` recorded what implementing the importer against the real workbook revealed. Phase 3
turned up three points where the sources are each individually right and jointly need a
decision. All three are recorded here rather than being decided again in a later phase.

### R-8a — One `POST /audits`, three PART 6 cells

`ARCHITECTURE.md` §8.6 gives audit creation **one** endpoint carrying an `auditType` in the
body. PART 6 gives it **three** permissions — `audit:create_external`, `create_walk_by` and
`create_cross` — whose scope resolvers differ by role: a Consultant holds `assigned_units`
on the first two, a Zone Leader `own_unit` on the third.

A statically declared `@RequirePermission` has to name one cell, and whichever it names is
wrong for somebody: a Zone Leader starting a cross audit would be refused by
`create_external`, a cell that was never meant to judge them. Splitting the route into three
would contradict §8.6, which is binding on behaviour (R-1).

So the route declares a **dynamic requirement**: it lists the three candidate cells and a
selector that picks the one the request's `auditType` names. The guards are otherwise
untouched — same matrix, same resolver derivation, same `PermissionGuard` refusal for a role
holding no grant. Nothing widens: an actor naming a type they lack is refused exactly as
before, and an absent or unrecognised type falls through to `create_external`, the narrowest
of the three, so a malformed body cannot select the most permissive cell.

This is the **only** dynamic requirement in the codebase, and adding a second one needs a
reason as specific as this one.

### R-8b — A-2 needs its own trigger and a named carve-out

Invariant A-2 is conditional: `audit`, `audit_zone` and `question_response` become
append-only **after** `COMPLETED`, not from insert. The generic `enforce_append_only()`
written in `0001` cannot express that — it freezes a table from its first row, which is
correct for `audit_log` and wrong here, because until completion the auditor is still
answering.

Migration `0006` therefore carries `enforce_completed_audit_append_only()`, in the shape of
`0005`'s `enforce_published_version_immutable()`: a status-aware trigger with its exception
written beside the rule it bends. Two details are deliberate.

The **carve-out is named, not implicit**: the Super Admin override endpoint sets
`app.post_completion_override = 'on'` inside the transaction that also writes the
`AuditLog` entry, and `app_post_completion_override()` additionally requires the actor to be
a Super Admin — so the flag alone opens nothing. Without a path like this the override
happens in a DBA's psql session and leaves no trail at all, which is the outcome A-2 exists
to prevent.

The **audit's own lifecycle stays open**: corrective actions move a completed audit through
`CORRECTIVE_ACTION_OPEN`, `PARTIALLY_CLOSED` and `CLOSED`, so `status`, `closed_at`,
`updated_at` and `version` remain writable on the `audit` row. Those are status changes, not
edits to what was audited. Every other column, and both child tables, are frozen.

`DELETE` has no carve-out at any level, for anyone, under any flag (A-1, D8).

### R-8c — The `selfie_captured` guard is a seam, not a stub

`ARCHITECTURE.md` §7.1 guards `ASSIGNED → READY` on a captured selfie. The `evidence` table
arrives in Phase 4, so in Phase 3 there is no row a selfie could be and
`audit.selfie_evidence_id` has no referent to point at.

Both obvious readings are wrong. A guard written to require a row that cannot exist refuses
every start; a guard quietly omitted has to be remembered back into existence three phases
later, and the state machine would meanwhile say something untrue.

`SelfieRequirement` is therefore an injectable with one method and one named constant,
`EVIDENCE_ENFORCED`, in the shape `ObjectStorage` and `zone_has_in_progress_audit()` already
use in this repository: Phase 4 replaces the implementation with one that reads `evidence`
and flips the constant, and every caller stays as it is. A grep for the constant finds the
whole of what Phase 4 has to change.

---

## R-9 — What "presigned" means under the filesystem driver

`ObjectStorage` has two drivers (STACK.md §2): S3 for the deployed environment, and a
filesystem driver for development and CI. Phase 4 needs `presignPut` and `presignGet`
(§9.4, §12.6) — and a filesystem has no signing authority, so the port's two newest verbs
have no literal meaning under it. MinIO would have supplied one; it cannot be pulled here
(Docker Hub answers 403 under this session's egress policy), and in any case pinning the
development path to a container that CI may not be able to fetch trades one problem for
another.

Three readings were available, and two are worse than they look.

**Refuse to presign, and upload through the API instead.** The device would then POST its
bytes to an authenticated endpoint in development and PUT them to a signed URL in
production. That is not one protocol with two drivers; it is two protocols, and the one the
tests exercise is the one that never ships. Every bug specific to the presigned flow —
a header the signature covers, a checksum the store enforces, a session the PUT must *not*
carry — would be invisible until deployment.

**Return an unsigned URL to a public route.** One line of code, and it makes the
development environment a file server with no access control, which is exactly the shape of
mistake that reaches production by being convenient.

**What was built.** The filesystem driver mints a real URL with a real expiry, signed with
HMAC-SHA256 over the method, the object key and every query parameter, and serves it from a
`@Public()` route this application hosts under `/api/v1/__local-object-storage/`. Every
property the calling code depends on is genuine:

* the URL expires — `expires` is inside the signature, and a stale link is refused as
  `EXPIRED`, not merely ignored;
* the signature is the only authority — the route carries no session, so a test that
  accidentally authenticates the PUT fails the same way it would against R2;
* the PUT's declared content type and byte size are signed, and the route enforces both, so
  an oversized or mistyped body is rejected before `commit` ever runs;
* the SHA-256 is verified where §9.4 puts it, at `commit`, from a `head()` both drivers
  implement. S3 additionally signs `ChecksumSHA256` so the provider refuses a mismatched
  body at the edge; the filesystem driver computes the digest on read instead. That is the
  one asymmetry, and it fails *closed* — the weaker driver is the one used only in
  development, and `commit` catches what it lets through;
* the TTL caps of §12.6 (GET ≤ 300 s, PUT ≤ 900 s) are applied in the port, above both
  drivers, so neither can exceed them.

What is *not* genuine is the one thing a filesystem cannot do: the bytes transit the API
process rather than going straight to object storage. The port says so out loud rather than
hiding it — `presignsOffProcess` is `false` on this driver and `true` on S3 — and the API
logs a warning at every boot naming the driver, the directory and this decision. The route
prefix is `__local-object-storage` precisely so that a request to it in an access log from a
deployed environment is unmistakable; there, `R2_ENDPOINT` is set, the S3 driver is
selected, and the route answers 404.

The signing secret defaults to 32 random bytes per process, so a restart invalidates
outstanding links. That is the right default for a driver that is not a production path:
`OBJECT_STORAGE_SIGNING_SECRET` exists for the one case that needs stability, which is a
test run spanning a restart.

This branch is not untested. `local-object-storage.test.ts` covers the signature, the
tamper cases, expiry, the size and type enforcement and the key encoding; the evidence e2e
suite drives intent → PUT → commit through it; and both browser walkthroughs fetch evidence
back through a presigned GET, out of process, with no session.

One implementation detail is worth recording because the obvious version is a hazard. The
object key contains slashes, and a Fastify wildcard route declared inside a controller
prefix registers as a **root-level** `*` — which would have matched every unmatched path in
the API and turned a storage route into a catch-all. The key is therefore base64url-encoded
into a single path segment.

---

## R-10 — Evidence is append-only after completion, not from insert

D8 freezes "post-completion Evidence", and `0001`'s generic `enforce_append_only()` cannot
express that: it freezes a table from its first row. Evidence has a life before completion —
`commit` fills in the object key and the checksum, E-2 reclassifies it when the answer
changes, the auditor flags it for the summary, and E-4 allows a soft delete — so an
unconditional trigger would break the capture flow it is meant to protect.

`0007` therefore carries `enforce_completed_evidence_append_only()` in the shape R-8b
established for A-2: status-aware, reading the parent audit's status, and refusing both
`UPDATE` and `DELETE` once it is `COMPLETED`. It takes its carve-out from `TG_ARGV` the way
`0001` parameterised the generic trigger, and the three columns named there are exactly
R-5's redaction fields — `redacted_at`, `redacted_by_user_id`, `redaction_reason`. Naming
them in the `CREATE TRIGGER` rather than inside the function keeps the exception visible at
the point the rule is attached.

R-5 is why the carve-out exists at all: redaction replaces the object and records who
replaced it and why. It never deletes the row, so `DELETE` has no carve-out here either.

---

## R-11 — `expo-camera` vs `react-native-vision-camera` *(open — needs a ruling)*

The two source documents disagree, and R-1's precedence rule does not settle it cleanly:

* `STACK.md` §2: *Camera — react-native-vision-camera (in-app live capture only, no gallery path)*
* `ARCHITECTURE.md` §12.10: *Custom camera view (`expo-camera`)*

R-1 says STACK.md wins on any technology name, so on the letter of the rule the answer is
vision-camera. Phase 4 shipped `expo-camera` anyway, and this entry exists so that is a
recorded deviation rather than a silent one.

**Why it was built that way.** The app is a managed Expo project pinned to React Native
0.86.3 with `expo-router`. `expo-camera` is in that dependency set already and needs no
native build to run or to prove; `react-native-vision-camera` needs a config plugin and a
custom dev client, neither of which can be produced in this environment — so choosing it
would have meant writing a capture component nobody could execute, and `is_live_capture` is
not a property worth asserting from untested code (§12.10 is already explicit that live
capture is deterrence plus evidence, not prevention).

**What the deviation actually costs.** One file: `src/components/camera-capture.tsx` is the
only importer of `expo-camera` in the workspace, and everything downstream of it — the
capture contract, the object key, `is_live_capture`, E-1, the outbox row — is library-
agnostic. Swapping it is a component rewrite and a dependency change, not a redesign.

**What is needed.** A ruling on which document is right. If `STACK.md` is, the swap should
happen in a phase that can produce a dev client and put a real camera in front of it; if
`ARCHITECTURE.md` is, `STACK.md` §2 should be corrected and this entry closed with the
change recorded in the header table.

Until then the code follows `ARCHITECTURE.md` §12.10 and this entry is the flag.

---

## Related: migrations

There is one environment. Migrations are files in git, applied by CI — never
`drizzle-kit push` against production — and the deploy step takes a pgBackRest snapshot
immediately before applying.
