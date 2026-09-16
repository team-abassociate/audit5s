# Decision record — resolutions R-1 … R-18

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
| R-7 | What the importer settled against the real workbook | Settled |
| R-8 | What the audit engine settled | Settled |
| R-9 | Presigning under the filesystem driver | Settled |
| R-10 | Evidence append-only after completion | Settled |
| R-11 | Camera: `expo-camera` | Settled |
| R-12 | Phase 5: walk-by constraints and the media worker | Settled |
| R-13 | Phase 6: corrective actions and notifications | Settled |
| R-14 | Phase 7: what the reporting engine settled | Settled |
| R-15 | Phase 8: weighted analytics, own activity and rollup identity | Settled |
| R-16 | Phase 9: dead letters, retention, drain and the PDF clock | Settled |
| R-17 | Phase 9: how a data-integrity finding reaches a Super Admin | Settled |
| R-18 | A Super Admin is refused nothing | Settled |
| R-19 | The auditor names the Zone | Settled |
| R-20 | Access to the Unit is enough for an external audit | Settled |
| R-21 | A session has no time limit | Settled |
| R-22 | Anyone holding a corrective-action link may answer it | Settled |
| R-23 | An after-photo closes a finding; regenerating picks up the answers | Settled |
| R-24 | A Coordinator uses the field app too | Settled |
| R-25 | Removing a user is archiving them | Settled |
| R-26 | An audit may be assigned to anyone who can conduct one | Settled |

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

---

## R-13 — What building corrective actions and notifications settled

Phase 6 had to decide six things the sources leave open or state in two voices. They are
recorded together because they are one phase's reading of §2.8, §5.7, §5.9 and §7.3.

### (a) "Resolved" means VERIFIED — a submission is not a resolution

§2.8 rolls an audit `→ PARTIALLY_CLOSED` "when some are resolved" and `→ CLOSED` "when
every action is `VERIFIED` or `NOT_POSSIBLE`-accepted", and §5.7 defines `resolved_at` as
"`VERIFIED` or accepted `NOT_POSSIBLE`". §7.3's worked case then says the audit rolls to
`PARTIALLY_CLOSED` on the Monday three submissions arrive — before anybody has reviewed
them.

**Settled: resolved is VERIFIED**, as the column and both prose statements define it. The
audit stays `CORRECTIVE_ACTION_OPEN` while attempts await review, becomes
`PARTIALLY_CLOSED` when at least one action is verified, and `CLOSED` when all are.
`rollupAuditStatus` in `packages/domain` is the one implementation, and the acceptance
suite asserts the whole Monday-to-Friday sequence against it.

The worked case's sentence is read as shorthand for the progress it describes rather than
as a third definition of `resolved_at`. **If the business wants submission alone to move
the audit**, this is the one line to change — and it is a product decision, not a fix.

The state machine has no `CLOSED → CORRECTIVE_ACTION_OPEN` edge, which a single-action
audit needs when its only action is reopened. `rollupPath` walks §7.1's edges instead of
inventing one: `CLOSED → PARTIALLY_CLOSED → CORRECTIVE_ACTION_OPEN`, each asserted.

### (b) Materialisation is part of completing, not a job

§4.2 lists `AUDIT_COMPLETED`'s consumers as "CorrectiveActions (materialize),
Notifications, Analytics", which reads as three asynchronous handlers. Notifications and
analytics are; materialisation is not.

It runs **inside the completing transaction**: the status write, one action per
nonconformity photograph, and the audit's roll onward to `CORRECTIVE_ACTION_OPEN` or
`CLOSED` commit together, and the event is enqueued on that same transaction (R-2). A
completed audit whose actions have not been raised yet is not a state the system can be
observed in — which matters because §7.1 gives `COMPLETED` two outgoing edges and nothing
that would tell a reader an audit is *between* them.

The asynchronous alternative needs an actor: this schema has no system bypass, so the job
would have to become somebody to insert rows RLS admits. The completing auditor is already
that somebody, in a transaction that is already open.

Two consequences worth stating. An audit rarely rests on `COMPLETED`, so
`isAuditCompleted()` — not `status === 'COMPLETED'` — is what "is it finished" means
everywhere. And a replayed `complete` is still idempotent: `UNIQUE(evidence_id)` with
`ON CONFLICT DO NOTHING` raises nothing twice.

### (c) An after-photo is scoped by its action, not by its audit

`CORRECTIVE_AFTER` evidence hangs off an audit that is completed by definition — that is
what "after" means — so three rules written for audit evidence contradict it: R-10 freezes
the row before `commit` can confirm it, `evidence:create`'s `own_audits` hides it from the
Zone Leader who took it, and §5.6's `corrective_action_submission_id` FK points at a row
that does not exist yet, because the device mints the attempt id when the form opens.

So, in `0009`:

* `evidence.corrective_action_id` is added. It is the only way from an after-photo to the
  scope that governs it before an attempt exists, and PART 6's own words are the rule it
  implements — `evidence:create` is `own_audits` "**or `assigned_actions`, for
  `CORRECTIVE_AFTER` evidence**".
* `corrective_action_submission_id` carries the client-minted id and takes **no** foreign
  key; the link is enforced from the other side, by a trigger on the submission insert,
  which is also where CA-2's live-capture requirement is checked.
* R-10 reaches an after-photo **once an attempt cites it**, through a `SECURITY DEFINER`
  predicate so the permissive answer never comes from an RLS policy hiding the row that
  would have said otherwise. Before that it is the photographer's; after it, it is the
  record of what was submitted, and it freezes like any other evidence.

### (d) The notification worker becomes each recipient

`worker-general` has no actor of its own, and the rows it must write and read belong to
people it is not: every Super Admin, a Unit's Coordinator, another user's preferences.

Two mechanisms, both narrow. `app_notification_targets()` is a `SECURITY DEFINER` lookup
returning ids, roles and two switches for active accounts — no names, no phone numbers, no
login ids. Then each notification is written **as its recipient**, so `notification`,
`notification_delivery` and `notification_preference` keep ordinary own-record policies
rather than an insert policy wide enough for a worker.

Delivery happens after those rows commit, never inside the transaction (STACK.md §5), and
every attempt is recorded — including the ones that could not be made.

### (e) WhatsApp and SMS are a port, and SKIPPED is an answer

STACK.md §2 keeps both behind an interface "not wired at MVP"; §5.9 specifies a fallback
between them. Both hold: `MessageChannel` has one unwired implementation, so a delivery on
either channel is recorded `SKIPPED` with its reason rather than quietly not happening. A
WhatsApp failure — or an unconfigured provider — writes the SMS fallback as a second
`notification_delivery` row pointing at the first, so §5.9's "auditable rather than
invisible" is true before any provider exists. Binding a real BSP is one provider in
`MessagingModule`.

§5.9's "verified phone" has no column behind it: `user.phone_e164` is required and there is
no verification flow, so an active account's phone is treated as reachable. A real
verification step would add the column and one condition here.

### (f) Two columns the schema needed, and one default

`notification.event_id` makes a redelivered job idempotent — pg-boss may deliver twice, and
a Zone Leader must not be told twice; with the recipient it is unique.
`notification_delivery.fallback_of_delivery_id` is what makes the fallback in (e) legible.
`corrective_action.due_at` has no rule anywhere: `CORRECTIVE_ACTION_DUE_DAYS` defaults to
seven days from completion and `0` disables it. **That seven is a house default, not a
business requirement** — the first person to state a real deadline policy should change it.

---

## R-14 — What building the reporting engine settled

Phase 7 had to decide five things the sources state in an order the schema cannot follow,
or leave open. They are recorded together because four of the five are consequences of one
requirement: **the PDF prints a link**.

### (a) Tokens are minted before the render, not after it

§10.2's pipeline sketch ends

```
→ worker: HTML template + payload → headless Chromium → PDF
→ upload to S3, compute checksum
→ mint ReportAccessToken rows
→ status = READY
```

That ordering cannot produce the document §10.3-A and HANDOFF.md §4.1 describe. Both
require a **"View / Submit Corrective Action" button per nonconformity, linking to the
signed `/ca/{token}` route** — and a link minted after the render cannot appear in it.

So minting happens in the freeze, and the URLs are frozen into the payload. Two properties
follow, and the second is why this is the better ordering rather than merely the possible
one:

* the payload stays **self-contained**, which is §10.1's first principle. A renderer that
  had to go and fetch a link would make the document depend on something outside the
  snapshot, and §10.5's "a two-year-old snapshot still renders with the layout it was
  designed for" would stop being true of its *content*;
* **the same payload renders to the same bytes**, which is what PART 15.7's byte-stability
  test asserts and what makes "regeneration leaves v1 byte-identical" checkable rather
  than hoped for.

One ordering detail the schema forced, recorded because the obvious code is wrong:
`report_access_token.snapshot_id` references the snapshot, so the token rows cannot be
written before it exists — while the snapshot's payload must already contain the links. The
minting is therefore two halves on one transaction: `prepareForSnapshot` generates the
secrets and URLs and writes nothing, then the snapshot is inserted, then `persist` writes
the rows. A link never outlives a report that rolled back.

A token is **not** minted for an already-verified finding. The right half of its row
already carries the outcome; a live door on a closed item is not something to hand out.

### (b) Photographs are embedded, not fetched at render time

HANDOFF.md §4.1 says report images are "fetched by the worker through short-TTL presigned
GETs". The worker does fetch them from object storage — through the `ObjectStorage` port —
but it does so **before Chromium starts**, and embeds them as `data:` URIs.

Resolving a presigned GET *inside* the page would put the network in the middle of the
render, and with it: request timing, a provider's latency, and a five-minute TTL that can
expire between the first image and the fiftieth. Determinism is not a nicety here — it is
the property the byte-stability test checks and the property RS-1 depends on. The
requirement's substance is honoured more strongly by embedding: the photograph does not
travel as a URL at all, and the document does not depend on a live link.

The same reasoning rules out a web font. The stylesheet is system fonts only.

### (c) The commit moves inside the public submission

§9.4's second phase — `POST /evidence/{id}/commit` — is authenticated, and the live
corrective-action page has no session. §10.4 is explicit that the link "authorizes exactly
two operations and grants no other API access", and §8.8 gives the public surface three
routes; a fourth to carry the commit would widen the one surface that is meant to be narrow.

So `POST /public/corrective-actions/{token}/submissions` commits the after-photo on the way
in. Nothing is skipped — the HEAD, the size, the checksum and §12.8's magic-byte sniff all
run, because they are server work and the server is already there. It is idempotent (§9.6),
so a submission retried after a dropped connection commits nothing twice and finds its own
attempt rather than making a second.

### (d) A signed link narrows; it never widens

`signed_token` is a scope resolver like any other, and the route declares it in place of the
matrix's own — the only place in the codebase where those differ. It is not an exception to
PART 6 but a reading of it: the Zone Leader cells this surface reaches say
`assigned_actions` / `own_unit` **"or via a valid signed token"**, and `signed_token` is
strictly the narrower of the two. It resolves to one corrective action in one Unit, against
a resolver that would otherwise admit every action of that Unit (R-3b). **A link cannot
reach further than the person holding it already could.**

`SignedTokenGuard` runs before `JwtAuthGuard`, which skips a route carrying its metadata.
The two guards after it run unchanged. These routes are deliberately **not** `@Public()`:
a public route has no actor and no scope, and these have both.

The actor is the Zone Leader the token was issued to, and that is not a convenience.
`corrective_action_submission.submitted_by_user_id` is `NOT NULL` and its RLS insert policy
requires it to be the acting user, so a page with no identity could not write an attempt at
all. A link bound to nobody — an action whose Zone has no leader — therefore authorizes
reading the finding and not answering it, and says so: `403` naming the Coordinator as the
person who can assign one. The alternative, making the column nullable, would have put an
unattributed row in an append-only table to save a Coordinator one click.

Validating a link is a pre-authentication read, and it reuses the mechanism `/auth/login`
already has — `app_in_auth_phase()` — rather than inventing a second one. The lookup key is
a 256-bit secret, exactly as the login lookup is a login ID plus a verifier.

### (e) Two display names need a definer function, and one column did not need to change

A report records who generated it, always a Super Admin (N5) — and the Coordinator and Zone
Leader who read it cannot see a Super Admin's `user` row. Joining `"user"` for that one
string hid the whole report from exactly the people it is for: an inner join under RLS
returns nothing, and the report came back `404`. The public page's auditor name had the same
fault. Both now go through narrow `SECURITY DEFINER` functions in the shape 0008 established
for `app_zone_leader_name` — one column, for one row, and only where the caller could
already reach the report or the audit.

This is worth stating as a rule rather than two fixes: **a display name is not a reason to
join a table the reader cannot see.** Every future read that prints somebody's name across
a scope boundary has this shape.

### (f) A version belongs to the Zone, not to the kind

§5.8 indexes `UNIQUE(audit_zone_id, kind, version)`, which reads as a version sequence per
kind. §10.5's chain is explicit that it is not:

```
audit_zone X
 ├── ReportSnapshot v1  INITIAL_ZONE         [immutable]
 ├── ReportSnapshot v2  AFTER_EVIDENCE_ZONE  supersedes v1
 └── ReportSnapshot v3  AFTER_EVIDENCE_ZONE  supersedes v2
```

An after-evidence report of a Zone is **v2 of that Zone's report**, not v1 of a separate
after-evidence series. Behaviour wins (R-1), and it is the reading the phase's own
acceptance criterion requires — "regenerates an After-Evidence report as version 2" — and
the one an external certification body reading "version 2" expects. It is also what makes
`supersedes_snapshot_id` a single chain rather than two that happen to share a Zone.

The index stands as §5.8 writes it; it is simply wider than the sequence needs.

This also settles what `regenerate` means. It re-issues **the same kind** of document as
the next version — "generate this again, now that something has changed". Producing an
after-evidence report is a different act and goes through `generate` with that kind, which
lands on the same chain. A `regenerate` that inferred a new kind from the audit's state
would make one button mean two things.

Finally, `expires_at` is fixed at minting by a trigger, along with the hash and the
audience. §10.4 makes the expiry a property of the link; extending one would change what a
document already in somebody's hands means. The remedy is to mint another, which costs
nothing, and the error message says so.

---

## R-15 — What building analytics settled

### (a) Every aggregate score remains `Σraw / Σmax`

PART 11 calls Unit and organization scores a mean and its illustrative queries use
`avg(score_percentage)`. That conflicts with §10.3-C, D4, the Phase 7 handoff and the one
shared scoring implementation: scores with different applicable denominators may not carry
equal weight. Behaviour therefore remains `Σraw_score / Σmax_score`, through
`packages/domain`'s `sumTotals`; a fully-NA aggregate remains `null`.

The three rollup tables store `raw_score` and `max_score` in addition to the display
percentage named by §5.9. Without those two derived columns, combining daily rows into a
month would force a mean of percentages and silently reintroduce the disagreement.

### (b) Mobile own activity has one narrow route

PART 6 grants `analytics:own_activity` and Phase 8 requires the Consultant mobile summary,
but §8.10 lists only organization and Unit analytics routes. `GET /analytics/activity/me`
is the missing transport. It uses the existing `own_record` resolver and returns only the
acting Consultant's or Zone Leader's row; it is not a filter on the organization-wide
activity endpoint.

### (c) The nightly job rebuilds the last complete local day

Each Unit has one pg-boss schedule on `maintenance.sweep` at 02:00 in that Unit's IANA
timezone. The job identity is stable per Unit, and the worker rebuilds the previous local
calendar day with idempotent upserts. Derived-table writes run under the narrow system
Super-Admin database context already admitted by their RLS policies; every source read
still carries the Unit predicate. No rollup row is authoritative, and rerunning a day does
not change an already-identical row.

---

## R-16 — What hardening the queue settled

Phase 9's first slice. Four findings, recorded together because three of them are one
mistake: a policy that was written down, believed, and never actually in force.

### (a) A failed job needs somewhere to go, and it had nowhere

`STACK.md` §5 asks for "one retry, then a visible dead-letter" for the report worker, and
two workers carry comments saying a failed job "dead-letters where a human can see it".
None of that was true: `createQueue` was called with no options, so no queue had a dead
letter, and a job that exhausted its retries stopped at pg-boss's `failed` state and was
deleted with the rest of the queue's history. The payload that could not be processed was
gone by the time anyone asked what had happened.

Every queue now has a `<queue>.dlq` companion, and the retry policy is set **on the queue**
rather than at each `send`. That distinction is the point: queue options are inherited by
every job, so a job enqueued by code that passed no options is still retried and still
dead-lettered. Before this, only two call sites set anything, which left the media pipeline
and the nightly rollup on pg-boss's bare defaults — two immediate retries, no dead letter.

`create_queue` is `ON CONFLICT DO NOTHING`, so a policy change is applied with
`updateQueue` after it. Without that second call the new policy would reach a fresh
database and no deployed one, which is the only case that matters after the first boot.

### (b) The retention policy named a mechanism pg-boss no longer has

`STACK.md` §5: "Set a pg-boss archive-retention policy on day one, or completed jobs become
the largest table in the database." It was set — with `archiveCompletedAfterSeconds` and
`deleteAfterDays`, which are pg-boss 9 constructor options. Version 12 has no archive stage
and no such options; retention is a queue option, `deleteAfterSeconds`. The two settings
were silently ignored, and a `as unknown as ConstructorParameters<…>` cast is what stopped
the compiler from saying so.

The two environment variables are replaced by one, `PGBOSS_JOB_RETENTION_DAYS`, applied
where pg-boss reads it. **A cast that exists to make configuration compile is a bug report
in waiting**; this one hid a rule the handoff calls out by name.

### (c) `/health` reports `degraded`, and reads the count live

§16.12 puts dead-lettered jobs in the warning band, not the paging one, and `/health` is
the only surface BetterStack polls. So the check answers **200 with `degraded`**: the API
is serving every request correctly, and paging on lost background work would train the
on-call to ignore the page. `error` stays for a dependency the API cannot reach.

The count is a query, not `getQueues()`. Those are pg-boss's *cached* per-queue counters,
refreshed by its monitor every sixty seconds — so a health check reading them is zero for
the first minute of every incident. The Super Admin dashboard's `deadLetterCount` had the
same fault, from the same call, and now shares the live read.

The paging half of §16.12 — "queue stalled >15 min" — is **not** built. It needs the age of
the oldest ready job, which neither cached counters nor the health surface currently carry.

### (d) The PDF clock: a real defect wearing a flaky test's clothes

PART 15.7's byte-stability test failed roughly one run in four, on a clean tree, with no
other explanation. The cause is not the test. Skia stamps the wall clock into the PDF's
`/CreationDate` and `/ModDate`, to the second, so two renders inside one second agree and
two that straddle a boundary do not. R-14's "the same payload renders to the same bytes"
was simply false, and the renderer's own "no clock" comment named three clocks it had
switched off and missed the fourth.

`freezePdfDates` rewrites both fields to the payload's frozen `generatedAt`, in place and
at exactly the same width so every cross-reference offset stays valid. A separate test
asserts the metadata specifically, so a regression names the cause instead of reappearing
as intermittent failure.

### (e) Draining is now allowed to finish

pg-boss's `stop` already waited for in-flight handlers; `docker compose` did not. Its
default `stop_grace_period` is ten seconds, so SIGTERM was followed by SIGKILL well inside
a 120-second report render. The grace period is now 180s on all three application services,
above the 150s drain the application asks for, so the timeout that expires first is the
application's own.

---

## R-17 — How §16.4's data-integrity findings reach a Super Admin

Phase 9's second slice. §16.4 asks for four nightly checks and says twice that what they
find is "surfaced to Super Admin", without saying through what. Two candidate transports
were left open deliberately, because they are not equivalent and the choice is not
reversible cheaply.

### (a) The notification fan-out, because the notification *is* the record

The alternative was a read endpoint — `GET /ops/integrity`, or similar. It looks like the
smaller idea and is not, for a reason that only shows up when you ask where the finding
lives between the sweep and the read:

- A read endpoint has to read something. The sweep runs at 02:00 and the Super Admin looks
  at 09:00, so the findings must be **stored**, which is a new domain table and therefore
  migration `0012` — for rows that are pure derived observation and that nothing else joins.
- PART 6 has no `ops` and no `system` resource. A route needs one, plus a permission, plus
  a scope rule, plus `role_permission` seed rows, plus authorization-matrix entries and
  their tests. That is a PART 6 change, and PART 6 is the document the authorization suite
  is written against.
- It is a **pull** surface. Nobody opens a page that is empty 364 nights a year. §16.4 says
  "surfaced", not "queryable", and §16.12 puts every one of these findings in the warning
  band — a band that only exists because something is pushed into it.

The notification path needs none of that. `notification.event_type` is `text`, and
migration 0009 says why in a comment on the column: *"a new event type must not need a
migration."* The fan-out already resolves every Super Admin organisation-wide through
`app_notification_targets`, already writes each row as its recipient, already dedupes on
`(event_id, recipient_user_id)`, already has a centre to read it in and a preference grid
to tune it. The notification row is both the delivery and the durable record, so the
storage question disappears rather than being answered.

**Cost of the choice, stated plainly:** one new value in `NOTIFICATION_EVENT_TYPES` — a
`packages/contracts` change — and one row each in `RECIPIENT_ROLES` and
`renderNotification`. No migration, no route, no permission, no matrix entry.

### (b) One event type, not four

`DATA_INTEGRITY_ALERT` carries all four checks' counts in `data` and names the non-zero
ones in its body. Four types would put four rows in the centre on a bad night, four rows ×
three channels into every preference grid, and four near-identical cases in the renderer —
to distinguish findings that arrive together, from one job, about one Unit, and that a
Super Admin acts on in one sitting.

It is **in-app only**: not in `WHATSAPP_EVENTS`, because a 02:00 WhatsApp about an orphan
photograph is how a person learns to mute the channel that also carries §2.5's assignments.

The event is emitted **only when at least one count is non-zero**. A nightly "nothing
wrong" notification is a nightly notification, and the health of the sweep itself is
already visible: §16.1's per-job log line covers every run, and a sweep that stops running
dead-letters (R-16a).

### (c) What the four checks can honestly mean

The server sees its own side of the sync boundary and no more, so two of §16.4's phrasings
need a definition rather than a query:

- **"Evidence rows with no object after 24 h"** is `sync_state <> 'SYNCED'` — the row is
  inserted at intent and only `commit` sets `SYNCED` and `uploaded_at`, so the state
  already means "no object". It is not a `head()` per row against R2; that would be a
  bucket request per orphan candidate to re-derive what the column records.
- **"Devices with unsynced data (>48 h)"** cannot be data the server has not received. Its
  one honest proxy is a device that still **owns** an audit in `IN_PROGRESS` or `PAUSED`
  and whose `last_sync_at` is older than the threshold: the lock says work is on that
  phone, and the silence says it is not coming back on its own.
- **Score reconciliation** compares the stored `raw_score`/`max_score` against a
  recomputation through `ScoringService.summarise` — the same `packages/domain` path the
  write used. Integers are compared, never the rounded percentage, so a drift is a drift
  and not a rounding artefact. It is a sample (the 20 most recently completed per Unit per
  night), as §16.4 asks.
- **Stale in-progress audits** is the one that needs nothing: `status IN
  ('IN_PROGRESS','PAUSED')` and `started_at` older than 7 days.

The thresholds are constants in the worker rather than environment variables. §16.4 fixes
all four numbers, nothing deployment-specific moves them, and four knobs nobody turns are
four more rows in `.env.example` to keep true.

### (d) The orphan-**object** sweep is deliberately not built

§16.4 lists it and answers it in the same line: *"objects with no evidence row (should be
empty by design)"*. The design it refers to is this one, and it holds in both directions:
the evidence row is inserted **before** the key is presigned, and nothing is ever
hard-deleted (`STACK.md` §5, R-5 — erasure overwrites the object and keeps the row). So
there is no path from a committed object to a missing row.

The one leftover the code can actually produce is a thumbnail written by the media worker
whose row update then failed. Its key is derived deterministically from the original's, so
the next attempt overwrites it rather than adding a second one; it is bounded, not
accumulating.

Building the check anyway would mean a `list(prefix)` method on the `ObjectStorage` port,
an implementation in both drivers, and a nightly `ListObjectsV2` per Unit against R2 — to
re-verify a guarantee that `BEFORE DELETE` triggers hold and that has its own tests.
**Build it when either half of the design above stops being true:** a hard-delete path
appears, or anything other than the API writes into the bucket.

### (e) §16.4's outbox lag alert has no subject

"Outbox dispatcher lag alert" is the last box in §16.4 and there is no outbox to lag:
R-2 removed `domain_event` and made pg-boss the only enqueue mechanism. The checkbox is
**not applicable**, not outstanding. The nearest live concern — a queue that has stopped
being consumed — is §16.12's paging condition, still open and still recorded in R-16(c).

---

## R-18 — A Super Admin is refused nothing

**Changes `ARCHITECTURE.md` §6.3 (the SA column), §7.1–§7.3 (the actor lists) and §8.11.**
Settled 2026-09-13 by the product owner: *"a super admin shouldn't be refused … he must not
be refused anything in the app."*

Before this, sixteen cells of §6.3 withheld from the Super Admin everything a device does —
starting, answering and completing an audit, capturing evidence, answering a corrective
action, and `sync` itself — so he could not use the field app at all.

### (a) One rule, not sixteen cells

`PERMISSION_MATRIX` grants `SUPER_ADMIN` every permission any role holds, under
`organization`. It is written as a rule over the definitions, so a permission added later
cannot lock him out, and the matrix test asserts it. It is still a resolver through the same
code path — **AZ-4 stands**; nothing became a bypass flag. His own inbox keeps `own_record`.

### (b) What followed from the rule

- **State machines.** `canTransition` admits a Super Admin on every edge a person may take.
  Edges with no actors remain the system's.
- **Row-level security (migration 0013).** `audit_insert` required a Unit membership he
  cannot hold, and `app_may_answer_corrective_action()` named Zone Leaders only. Both gain
  him beside their existing clauses; neither widens for any other role.
- **Assignments.** `audit:create_external`'s "an active assignment must exist" is a
  condition on the Consultant's cell. A Super Admin is never assigned work, so he starts an
  external audit unassigned.
- **The catalogue.** A device signed in as a Super Admin carries every unverified corrective
  action, because he may answer any of them.

### (c) What did not change

- **One device owns an in-progress audit (D7).** The organization grant lets him *reach* any
  audit; it does not let him write to one another device holds. He runs his own audits, and
  frees a lost phone's lock with `release-device` as before.
- **Nobody deletes an audit (D8).** There is no such permission to grant.
- **Guards still apply.** A selfie, every question answered, a reason on a reopen — the
  rule removes role refusals, not the conditions of a move.
- **He may verify his own answer.** Submitting and verifying a corrective action were
  separate roles; they now meet in one person when a Super Admin does both. Accepted with
  the rule; every step is still audit-logged.

---

## R-19 — The auditor names the Zone

**Changes `ARCHITECTURE.md` §2.3 (step 8), §2.7 (steps 2 and 4) and the Zones rows of §6.3.**
Settled 2026-09-15 by the product owner. When a Super Admin assigns a Unit to a Consultant,
the Consultant opens that Unit and the first thing they do is take a selfie. Next they
create the Zone: a Zone number from a dropdown of Zone 1 to Zone 100, an optional
description, and the Zone leader's name. Then they select the department, and that
department's fifty questions are the ones asked.

That is `brainstorm.md`'s own flow. The build had drifted from it in two ways. The auditor
could only pick from Zones a Coordinator had already created, so a Unit with no Zones could
not be audited at all. And the department was never offered: the device pinned the first
published checklist, alphabetically, to every Zone.

### (a) A Zone number finds the Zone, or adds it

`PUT /audits/{id}/zones/{auditZoneId}` accepts `zoneNumber` (1–100) in place of `zoneId`.
The server uses that Zone of the audit's Unit — code `Z-07`, as `zoneCodeForNumber` has
always generated — and adds it, named "Zone 7", if the Unit has never used the number.
From then on it is master data like any other Zone. It appears on the web Zones page, a
Coordinator may rename it or assign its leader, and its score history accumulates across
audits, because `audit_zone.zone_id` still points at one row.

The number travels rather than an id because a device that is offline cannot know the id of
a Zone that does not exist yet. `zoneId` is still accepted, so payloads queued by an older
build still sync.

### (b) Narrower than `zone:create`

PART 6 still grants Consultants and Zone Leaders no `zone:create`, and `zone_insert` is
unchanged. The one new path is `app_ensure_zone_for_audit()` (migration 0014), a
`SECURITY DEFINER` function in the shape of R-12's and R-14(e)'s. It adds a Zone only to
the Unit of an open audit the caller is conducting, only by code, and returns nothing
otherwise. Each addition is written to `audit_log` as `zone.created`, naming the audit that
added it.

### (c) The leader is a name, not an account

The auditor types the Zone leader's name. It is snapshotted and printed on the reports, and
it grants nothing (C2 is unchanged). `zoneLeaderSnapshot` in `packages/domain`, used by both
the server and the device, keeps the Zone's leader account in the snapshot only when the
typed name is that person's; otherwise the snapshot would print one person and point at
another.

**Consequence, accepted with the decision.** Corrective actions still route from
`zone.zone_leader_id` (§5.7). A Zone added by number has no leader account, so nobody can
answer its nonconformities until a Coordinator or Super Admin assigns a Zone Leader to it.
Until then its signed links let people read the finding but not answer it (R-14(d)).

### (d) Description on every audit type; department per Zone

The optional description is now honoured on scored audits as well as walk-bys. The
department is chosen per Zone, and its checklist version is the one that Zone pins (QR-2).
Nothing else about the questionnaire changes.

### (e) What did not change

- **The selfie gate (§7.1).** The device now asks for the selfie as soon as the Unit is
  opened, which is where it always sat in the state machine.
- **D6.** Snapshots are still taken on the first write only.
- **A walk-by may still name a leader account** (§2.7 step 4); the device no longer offers
  it, but the API keeps it.
- **The web app does not conduct audits.** Its audit detail and the reports already print
  the snapshotted description, leader name and department.

---

## R-20 — Access to the Unit is enough for an external audit

**Changes `ARCHITECTURE.md` §6.3 (`Audit` · create `EXTERNAL_5S`, the Consultant cell).**
Settled 2026-09-15 by the product owner. The first audit run in the field was refused
with `ASSIGNMENT_REQUIRED`: the Super Admin had added the Consultant to the Unit but had not
also created an `AuditAssignment`. Given the choice, the owner chose the flow R-19 describes —
once a Consultant is added to a Unit, they may run a 5S audit there.

- **The resolver is unchanged:** `assigned_units`. Only the condition "and an active
  assignment exists" is dropped. A Consultant still cannot audit a Unit they have no
  membership in.
- **Assignments still mean something.** When an open assignment exists it is linked to the
  audit and moves through its statuses with it, so due dates and the assignment board keep
  working. Without one the audit starts unassigned, as a Super Admin's always has (R-18).
- **Found alongside it:** the phone dead-lettered the refused audit, and nothing on screen
  offered to send it again, so everything queued behind it was stuck too. "Sync now"
  now resets dead letters before syncing — `STACK.md` §5's "N failed — tap to retry" — so
  once the cause of a refusal is fixed, the work can go.

---

## R-21 — A session has no time limit

**Changes `STACK.md` §2 (Authentication) and `ARCHITECTURE.md` §2.1 step 1.** Settled
2026-09-15 by the product owner: *"make it unlimited, remove the 30 day limit."*

The web sign-in was reported as too short-lived. Two causes, fixed together:

- **A refresh race, which was the real complaint.** When the 15-minute access token lapsed
  under several requests at once, each refreshed with the same single-use token; invariant
  R-1 read the duplicates as theft and revoked the family, so users were signed out about
  every fifteen minutes. Both clients now share one refresh in flight, and the web holds a
  Web Lock across tabs.
- **The 30-day refresh lifetime.** `REFRESH_TOKEN_TTL_DAYS` now defaults to `0`, meaning no
  limit. Because `refresh_token.expires_at` is `NOT NULL`, "no limit" is stored as
  9999-12-31 — no migration. A positive value still restores a limit (at most 90 days).

**What did not change.** Refresh tokens are still single-use and rotating, and reuse still
revokes the whole family (R-1). A session still ends on sign-out, on a password change, and
when the account is disabled. Access tokens are still 15 minutes, so revoking a Unit or a
role still takes effect on the next request. The mobile offline unlock (`STACK.md` §5's 7-day
window without network) is a separate rule and is unchanged.

**Cost, accepted with the decision.** A stolen refresh token no longer expires on its own.
It is still stopped by the legitimate device's next refresh (reuse detection), by signing
out, or by a password change.

---

## R-22 — Anyone holding a corrective-action link may answer it

**Changes R-14(d) and R-19(c), and `ARCHITECTURE.md` §10.4's "bound to a Zone Leader".**
Settled 2026-09-15 by the product owner: *"once he generates the report he will send the
report via any media to a concerned person who might or might not be in the user list of
app so any person irrespective of the role assigned should be able to upload the after
evidence. basically anyone with the report and link can upload corrective action."*

Before this, a link acted as the Zone Leader it was issued to, and a link with none — every
finding in a Zone the auditor added by number (R-19) — could be read but not answered.

### (a) The link acts as its issuer when it names no Zone Leader

`corrective_action_submission.submitted_by_user_id` is `NOT NULL`, and its RLS insert policy
requires the acting user to be one who may answer the action. So a link still needs an
actor, and there are two candidates:

- the **Zone Leader it was issued to**, when there is one and the account is active —
  unchanged from R-14(d);
- otherwise the **Super Admin who generated the report** (`report_access_token.created_by_user_id`),
  who may answer any corrective action (R-18).

No migration and no new RLS policy were needed. Links already issued work at once, because
every token has always recorded its issuer.

### (b) The typed name is the author

A link's answer now always carries the name the person typed, for both options. The
`NOT_POSSIBLE` request gains an optional `submittedByName` (a `packages/contracts` change);
the public route requires it, while a signed-in user may still omit it and have their
account's name recorded. `submitted_by_user_id` therefore means *on whose authority*;
`submitted_by_name`, `submitted_via = WEB_TOKEN` and `access_token_id` say who answered and how.

### (c) What did not change

- **The link's reach.** Still `signed_token`: one corrective action, in one Unit, through
  the three public routes. It never becomes a session. Every use is still recorded.
- **Review.** Every answer still waits for a Super Admin to verify or reopen it.
- **Revocation.** A link sent to the wrong person is revoked from the Reports page.
- A link whose issuer has been disabled, and which names no active Zone Leader, is refused.

**Notification.** A submission through a link is raised with no actor, so the Super Admin is
told an answer arrived even when the link acted as them.

**Cost, accepted with the decision.** Whoever holds the PDF can answer its findings. The
control is who the report is sent to, the Super Admin's review, and revoking a link.

---

## R-23 — An after-photo closes a finding; regenerating picks up the answers

**Changes R-13(a), R-14(f), `ARCHITECTURE.md` §2.8 and §7.3.** Settled 2026-09-15 by the
product owner: *"this after evidence once uploaded by the person should be immediately
updated and the super admin get the notification and when he clicks on regenerate report he
get the updated version the one with the after evidence photo."*

### (a) No review step for an after-photo

An Option A answer (a description and a live after-photo) now moves the corrective action
straight to `VERIFIED`, from `OPEN` or `REOPENED`, on the submitting transaction. Two edges
are added to the state machine; `submissionTarget('COMPLETED')` is `VERIFIED`. The audit
rolls on (`PARTIALLY_CLOSED`, `CLOSED`) in the same transaction, as a verification rolls it.

- `resolved_at` is set (the table's CHECK requires it); `verified_by_user_id` stays null,
  because no person verified it. The attempt carries no review outcome for the same reason.
- The Super Admin is notified that the item was completed and closed, and may still reopen
  it with a reason — the `VERIFIED → REOPENED` edge is unchanged. The Unit's Coordinator gets
  the `CORRECTIVE_ACTION_VERIFIED` notification they had before (§2.8), raised by the
  closing submission with no actor, since there is no longer a verification to raise it.
- The audit roll-up runs as the system actor for that one step. Its edges have no human
  actor (§7.1), and the `audit` row's RLS admits only a Super Admin or the auditor, which a
  Zone Leader answering in the app is not.
- **Option B is unchanged.** "Not possible" still waits for a Super Admin to accept or
  reopen it, because nothing was fixed. Rows already in `ACTION_SUBMITTED` keep their edges
  and are reviewed as before.

### (b) A Zone report of an answered Zone is the after-evidence report

`generate` and `regenerate` for `INITIAL_ZONE` produce `AFTER_EVIDENCE_ZONE` once any
corrective action of that audit Zone has an answer, so Regenerate returns the version with
the after photos. It is still the next version of the same Zone's chain (R-14(f)); the
earlier versions stay exactly as issued.

---

## R-24 — A Coordinator uses the field app too

**Changes `ARCHITECTURE.md` §1.1 (the Coordinator authenticates on the admin web only).**
Settled 2026-09-15 by the product owner: *"please solve the coordinator login from mobile …
so that i can access the coordinator function from the mobile."*

- **Same screens as a Super Admin, narrowed.** A Coordinator gets the management tab set
  (Overview · Audits · Actions · Units · People). The server already scopes every list to the
  Coordinator's own Unit (`own_unit`), and each screen hides what `scope.permissions` does not
  list: no Unit creation, archiving or access grants, no audit assignment or starting, no
  report generation, no verify or reopen, and only Zone Leaders can be added or managed.
  Overview shows the Unit's score rather than the organization's.
- **§6.3 is unchanged.** Nothing is granted that the matrix did not already grant; the phone
  only stops refusing the role at the door. A hidden control is a courtesy — the API still
  refuses the request.
- **No sync.** A Coordinator holds no `sync:*` permission and records nothing offline, so the
  field app runs no sync cycle for the role; every screen is live server data.

---

## R-25 — Removing a user is archiving them

**Refines D8 for the admin UI.** Asked for 2026-09-16: *"the super admin only has one option
to revoke access not of delete so i want that the super admin should also have an option to
delete that user from the system."*

The intent is granted; the word cannot be. Every audit, photograph, submission and audit-log
row names the person who made it, with `ON DELETE RESTRICT` behind it, so a real delete
either fails or takes the record with it — and a 5S record that can be erased is not a
record. D8 says so outright, and it is the invariant the whole schema leans on.

So `user:archive` (Super Admin, `organization`) sets `archived_at` and `DISABLED` in one
statement and revokes every session and device. The account then leaves every list, every
picker and every search, exactly as a deletion would look from the outside, while what it
did stays intact. `POST /users/{id}/archive`, logged as `user.archived`.

- **Not self.** A Super Admin cannot archive their own account, as with `disable`.
- **Revoke access** stays: it stops sign-in and leaves the person in the list, which is what
  a suspension is. Archiving is for somebody who has left.
- **Memberships are left as they are.** They grant nothing to an account that cannot sign in,
  and cancelling their open assignments is `AA-1`'s path, reached by revoking the membership.

---

## R-26 — An audit may be assigned to anyone who can conduct one

**Changes the Auditor picker of `ARCHITECTURE.md` §2.1 step 10, not invariant AA-1.**
Asked for 2026-09-16: *"when the super admin is creating a new assignment and choosing the
auditor it shows the list of only active member in that unit … the super admin should be able
to choose any user who has been created by super admin."*

AA-1 stands: an assignee with no access to the Unit gets work their device never sees, and
the server still refuses such an assignment. What changes is that the Super Admin no longer
has to go and arrange the access first. The picker lists every active Consultant and Zone
Leader, marks those outside the Unit, and assigning one **grants the membership first, in the
same action**.

- **The server is unchanged.** Both steps are things a Super Admin may already do; the screen
  simply stops making them a two-place errand.
- **M-1 still binds.** A Zone Leader may hold one active Unit, so assigning one to a second
  Unit is refused — by the database, with its own message, which the form shows as it stands.

