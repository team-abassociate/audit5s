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

## Related: migrations

There is one environment. Migrations are files in git, applied by CI — never
`drizzle-kit push` against production — and the deploy step takes a pgBackRest snapshot
immediately before applying.
