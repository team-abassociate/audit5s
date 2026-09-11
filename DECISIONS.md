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

## R-11 — Camera: `expo-camera`, superseding `react-native-vision-camera`

The two source documents disagreed:

* `STACK.md` §2: *Camera — react-native-vision-camera (in-app live capture only, no gallery path)*
* `ARCHITECTURE.md` §12.10: *Custom camera view (`expo-camera`)*

**Settled: `ARCHITECTURE.md` §12.10 is right.** `STACK.md` §2 has been corrected and the
change recorded in `ARCHITECTURE.md`'s header table. The library is `expo-camera`.

This is the one case where R-1's precedence rule is overridden rather than applied, and it
is worth being explicit about why, because R-1 is otherwise binding: R-1 gives `STACK.md`
the technology name so that a *behavioural* document does not quietly re-pick a dependency.
Here the disagreement is not behavioural at all — both libraries can open a camera, and
§12.10's requirement is about what the capture surface must *not* offer. The row was simply
stale.

Everything §12.10 actually asks for is unchanged by the choice:

* **In-app live capture only.** The capture component is the sole path to a photograph.
* **No gallery picker** in the corrective-action or walk-by flows — `expo-image-picker` is
  not a dependency of `apps/field-mobile`, so there is nothing to reach for.
* **`is_live_capture = true` is set by the capture component and nowhere else**, and §12.10
  is already explicit that this is deterrence plus evidence, not prevention: a modified
  build or a rooted device can inject frames, and no library choice changes that.

The practical argument that made the decision easy: the app is a managed Expo project
pinned to React Native 0.86.3 with `expo-router`, and `expo-camera` runs there with no
custom dev client. `react-native-vision-camera` needs a config plugin and a prebuilt client,
which means a capture component that cannot be executed in CI or in this environment — and
`is_live_capture` is not a property worth asserting from code nobody has run.

The seam is narrow either way, which is why reopening this later would be cheap:
`src/components/camera-capture.tsx` is the only importer of the library in the workspace,
and everything downstream of it — the capture contract, the object key, `is_live_capture`,
E-1's classification, the outbox row — is library-agnostic.

`expo-location` was never in dispute; both documents name it.

---

## Related: migrations

There is one environment. Migrations are files in git, applied by CI — never
`drizzle-kit push` against production — and the deploy step takes a pgBackRest snapshot
immediately before applying.

---

## R-12 — Phase 5: the walk-by constraints, the media worker, and a wider R-10 carve-out

Four decisions Phase 5 had to make that the source documents left open. Recorded together
because they are one change to one table's rules.

### (a) What "walk-by-specific constraints" means

`ARCHITECTURE.md` PART 14's Phase 5 migration row reads *"Walk-by-specific constraints;
thumbnail key column"*. The second half was already done — `thumbnail_object_key` shipped
with the table in `0007`, beside the object key it describes — and the first half turned
out to be the opposite of what it sounds like.

`checklist_version_id` is already nullable on both `audit` and `audit_zone`, so a walk-by
Zone needs no schema change to *have* no questionnaire. Nothing was missing to permit a
walk-by. What was missing was anything to **refuse** one that contradicts §2.7's opening
four words, "No questionnaire, no score":

* nothing stopped a `WALK_BY` audit from pinning a checklist version, and
* nothing stopped a `question_response` from being written against a Zone that pinned none.

Either would make a walk-by look like a scored audit to Phase 7's renderer and Phase 8's
metrics, which is the failure PART 11's *"walk-by audits are excluded from every score
metric"* exists to prevent. `0008` therefore carries a CHECK on `audit`, a trigger on
`audit_zone` (which does not carry the audit type, and denormalising one onto the row to
make a CHECK possible would create a second copy of a fact that could then disagree with
the first), and a trigger on `question_response`.

The third is stated type-agnostically — *an answer needs its Zone's pinned version* (QR-2)
— rather than as *a walk-by has no answers*. The two are the same rule here, and the
type-agnostic form costs one primary-key lookup on the hottest write in the system rather
than two, on a row the INSERT's own foreign key is already touching.

### (b) The image codec: a structural strip plus `jimp`

The Phase 5 media-worker row asks for "thumbnails, EXIF". A thumbnail needs a decoder; the
EXIF strip does not, and should not use one.

**The strip is structural, in `packages/domain`.** `stripImageMetadata` walks the
container's own segment or chunk list and omits the metadata ones: `APPn`/`COM` in a JPEG,
`eXIf`/`tEXt`/`iTXt`/`zTXt` in a PNG, `EXIF`/`XMP ` in a WebP. No pixel is decoded, nothing
is recompressed, and §12.8's *"EXIF stripped except orientation"* is honoured by rebuilding
a minimal `APP1` carrying nothing but `Orientation`. A decode-and-re-encode would have been
three lines and would have recompressed a photograph the reports print at full size (§4.1
asks for print quality), lost the orientation §12.8 explicitly keeps, and put a decoder in
front of every object. Being pure and IO-free, it lives in `domain` beside `sniffImageType`
and is tested against hand-built adversarial files.

**The thumbnail uses `jimp`.** A resample needs a real codec, and `jimp` is pure
JavaScript: no native toolchain, no per-platform prebuilt binaries, and therefore nothing
that can fail on the `linux/arm64` image the deploy builds for an Ampere A1. `sharp` is
faster and is the obvious choice at volume; the volume here is ~200 photographs a day
(`STACK.md` §5 sizes the whole queue at ~200 jobs/day), which is three orders of magnitude
short of making the difference matter. **The trigger for revisiting it** is the media queue
becoming the worker's bottleneck — a sustained backlog, or thumbnailing measurably
lengthening a batch. An image codec is not on `STACK.md` §6's do-not-add table; the phase
row cannot be built without one.

`readImageDimensions` reads width and height from the header so the worker can refuse an
oversized decode *before* allocating the bitmap. That is §12.8's *"images decoded only in
the sandboxed media worker with resource limits"* made checkable: a 40 kB file declaring
30000 × 30000 is refused on its header rather than after 3.6 GB of allocation.

### (c) `stored_checksum_sha256` — why the sanitised object needs its own checksum

`checksum_sha256` is §12.8's tamper control: *"recorded at capture and verified at
commit"*. If the worker sanitises an object in place, the bytes in storage stop matching
it — and `commit` is idempotent by contract, because §9.6 makes replaying it the recovery
path for an app killed between the PUT and the confirmation. With one checksum column that
replay would answer `409 CHECKSUM_MISMATCH` for a photograph that is perfectly fine, and
the device would retry until it dead-lettered a good upload.

So `0008` adds `stored_checksum_sha256`, and `commit` verifies against
`stored_checksum_sha256 ?? checksum_sha256`. The capture checksum is never overwritten: it
is a historical fact about what the device sent, and it has already been verified.

The column carries a second meaning for free. Null is the normal case — the device strips
at capture (§9.4), so there is nothing to remove. Non-null therefore *reports* that a
device sent metadata it should not have, which is the diagnostic worth keeping and the
reason the worker logs what it removed by name.

### (d) R-10's carve-out is now six columns, not three

`0007` attached `enforce_completed_evidence_append_only()` with R-5's three redaction
columns as its `TG_ARGV`, and the carve-out **is** that argument list. The media worker
writes `thumbnail_object_key`, `media_processed_at` and `stored_checksum_sha256`, and it
runs asynchronously: a device that pushes the last photograph and the audit's completion in
one batch (the ordinary case — §9.3 batches up to 100 items) has the audit `COMPLETED`
before the job is picked up. Without those three names the job fails on every attempt and
dead-letters, leaving a completed audit's photographs with no thumbnails and a failure that
looks like a worker bug.

`0008` therefore **drops and recreates the trigger** with a six-name carve-out. The
function body is untouched; only the arguments change, which is what parameterising it was
for. Three properties make this a widening rather than a hole in D8:

* All three columns are **server-derived**. No API shape accepts any of them; one worker
  writes them, from the object's own bytes.
* None is an audited fact. A thumbnail is a smaller copy of an image the row already names;
  a processed-at is bookkeeping; a stored checksum describes the object rather than the
  finding. Nothing a report asserts or a corrective action answers changes when any of them
  is written.
* Everything the rule exists to freeze still refuses an UPDATE after completion —
  `classification`, `score_at_capture`, `is_summary_flagged`, `remark`, `object_key`,
  `checksum_sha256`, `captured_at`, the location columns, `deleted_at` — and `DELETE` still
  has no carve-out at any level, for anyone, under any flag.

`walk-by-schema.test.ts` asserts both halves: that the worker can write its three columns
after completion, and that each frozen column is still refused.

### (e) `evidence:patch` — a seventh sync operation

§9.3 lists five entity/operation pairs and does not name a patch, because at the time
nothing changed an evidence row after it existed. Phase 5 does: the summary flag and a
walk-by's classification are both decided *after* the photograph, often with the radio off.

`POST /evidence/upload-intent` cannot carry them. §8.7 makes it idempotent on the id — "same
`id` returns the same intent" — which is exactly what makes a retried upload safe and
exactly what makes it unable to change anything. So a flag toggled offline reaches the
server as `PATCH /evidence/{id}` through the outbox, or not at all; without this operation
the mobile flag toggle is a local-only preference that silently never syncs.

It sorts in the structure phase **after** `commit`, because E-3 refuses a flag on a
`NEUTRAL` photo and `commit` is where E-1 writes the authoritative classification — and
before every `complete`, because A-2 and R-10 freeze evidence the moment the audit lands on
`COMPLETED`.
