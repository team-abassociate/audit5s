# Decision record — resolutions R-1 … R-5

Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`STACK.md`](./STACK.md), the
Stack Decision Record (the engineering handoff).

These five resolutions settle points where the two source documents disagreed or were silent.
They are **binding** and carry the same weight as the decisions in `ARCHITECTURE.md` §1.4.
Where a resolution changes something in `ARCHITECTURE.md`, the affected section is named.

| # | Subject | Status |
| --- | --- | --- |
| R-1 | Document precedence | Settled |
| R-2 | Job enqueue mechanism | Settled |
| R-3 | Scope resolver enforcement | Settled |
| R-4 | Mobile local storage encryption | Settled |
| R-5 | Evidence redaction | Settled — **build before the append-only triggers ship** |

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

## Related: migrations

There is one environment. Migrations are files in git, applied by CI — never
`drizzle-kit push` against production — and the deploy step takes a pgBackRest snapshot
immediately before applying.
