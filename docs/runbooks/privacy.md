# Privacy — evidence photos

Evidence photos routinely contain identifiable people: operators at a workstation, a
supervisor in frame, a name on a locker. That makes them personal data, and
`ARCHITECTURE.md` §12.15 makes a retention policy, a lawful basis and a
subject-access/erasure process release-blocking before go-live.

This file records the position. **Two values below are defaults pending a decision**
(open question Q8) and are flagged as such.

## Erasure is redaction, never deletion

`DECISIONS.md` R-5 settles the apparent conflict between D8 (audit data is never
hard-deleted) and an erasure request:

- The private S3 object is overwritten with a placeholder.
- The `evidence` row survives, along with its `checksum_sha256` and the audit trail.
- `redacted_at`, `redacted_by_user_id` and `redaction_reason` record what happened.
- Reports render the item as a placeholder captioned "Photo removed".

The record therefore continues to state plainly that a photo was present and was removed,
which is what makes the audit still defensible after an erasure.

The append-only trigger on `evidence` permits an update touching only those three columns,
and that carve-out is built into the trigger function from the first migration — never
added afterwards to a trigger already live over real audit data.

## Retention

> **Default pending decision (Q8): 7 years**, from `ARCHITECTURE.md` assumption A12.

Evidence originals are retained for the life of the audit record. The retention period is
stated policy, not an object-storage lifecycle rule that happens to expire things — a
lifecycle rule is an implementation of a policy, never a substitute for one.

## Data fiduciary contact

> **Default pending decision (Q8): TBD.**

A named contact is required before go-live. "The engineering team" is not a contact.

## Consent at capture

The mobile capture screen carries a line stating that photos may include people and are
retained as audit records. It is cheap now and impossible to retrofit onto photos already
taken. It lands with the camera work in Phase 4.

## What is deliberately not built

No erasure-request queue, no admin UI, no self-service flow. The scope is the schema above
plus a Super Admin endpoint. The workflow comes when someone asks for it — building a
request pipeline before a single request has arrived would be speculation.
