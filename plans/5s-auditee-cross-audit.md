# 5S: photo after score, auto checklist, cross-audit assignment, auditee, locked Zone fields

Owner request, 2026-10-31. Two devices work at once:

- **Device A, krxna (macOS):** `packages/contracts`, `packages/db` (every migration),
  `packages/domain`, `apps/api`, `apps/admin-web`, `DECISIONS.md`, this plan.
- **Device B, geetahuja (Windows):** `apps/field-mobile/**` only.

Same ownership as the Kaizen work (`kaizen-device-a.md` §2). A device never edits the other's
folders. If B needs a contract change, B asks A; A ships it.

## 0. Branches and folders

These are 5S changes, so they do **not** go on `kaizen/krxna` / `kaizen/geetahuja`. One short
branch per PR, cut from `origin/main`, each in its own worktree:

| PR | Branch | Device | Depends on |
|---|---|---|---|
| P1 | `feat/photo-after-score` | B | nothing |
| P2 | `feat/zone-fields-server` | A | nothing |
| P3 | `feat/zone-fields-field` | B | P2 merged |

```bash
git fetch origin
git worktree add ../<branch-name-without-feat/> -b <branch> origin/main
```

Rules carried over from `kaizen-module.md` BRANCH RULE: PRs go straight into `main`, merge
commit only; `main` is production (merge = deploy + OTA), so CI green and the owner's go
first; stay current by merging `origin/main`, never rebase or force-push; never
`--no-verify`; commit as the device's own GitHub account.

**Merge order matters:** P2 (server) must be live before P3 (phone). An updated phone that
sends an auditee or a new photo kind to an old server is refused, and that audit sticks in the
outbox. P1 can ship any time.

No new APK: everything here is JavaScript and reaches phones by OTA.

## 1. Photo only after a score (P1, Device B, plus web in P2)

Today a question's camera and gallery buttons work with no answer chosen; the photo is
filed `NEUTRAL` (`classifyEvidence` with `scoreAtCapture: null`) and the report puts it in
neither section.

- `apps/field-mobile/src/app/audit/[auditZoneId].tsx`: camera and gallery for a row are
  disabled until that question has an answer (`picked[questionId] ?? row.value`). Tapping the
  disabled button says "Choose an answer first". Same for the gallery mutation (refuse before
  the picker opens, like `assertZonePhotoCapacity`).
- Once a question has a photo, its answer can be **changed** (the photo is re-filed, as
  today via `reclassifyLocalEvidence`) but not **cleared** back to no answer.
- Walk-by photos (`walk-by/`) are not question photos and are untouched.
- **Web (Device A, in P2):** the same rule in `apps/admin-web/src/features/conduct/ZoneRun.tsx`.
- Server: no change. Rejecting a scoreless photo server-side would strand photos already
  sitting in older phones' outboxes. Add it once every phone is on the new bundle, if wanted.

## 2. Checklists reach phones without a button (P1, Device B)

Checklist changes are data, not app code, so OTA is the wrong pipe for them. They already
travel on their own: `lib/sync/provider.tsx` pulls the catalogue on every sync cycle (app
open, return to the app, every 60 s online). The "Sync catalogue" button is leftover.

- `app/(tabs)/profile.tsx`: remove the Catalogue card and its "Sync catalogue" button.
- Replace the three "Sync the catalogue from Profile" empty-state texts
  (`(tabs)/audit.tsx`, `components/audit-start.tsx`) with "Connect to the internet once to
  load your Unit."
- The Coordinator has no sync cycle (no `sync:push`). Make sure they still pull on app open
  and resume: one `syncCatalogue` call on `AppState` → `active` for roles without
  `sync:push`, next to the existing cycle in `provider.tsx`.
- Behaviour to keep and to tell the owner: an audit already started keeps the checklist it
  started with; an edit reaches the **next** audit, on any phone that has been online for a
  minute since the edit.

## 3. Coordinator assigns who cross-audits which Zone (P2 server+web, P3 phone)

Today calling a cross audit tells **every** Zone Leader of the Unit. New (R-73): per Zone, the
Coordinator picks one person from the Unit's **Zone Leaders / Auditors**. Under R-64 that is
every Auditor-list account, external auditors included. Consultants are not on the list (R-64
hides them from the Coordinator). A Zone Leader may be given their own Zone (D9).

**Device A (P2), done in `feat/zone-fields-server`:**
- Migration `0060`: append-only `cross_audit_assignment` (call, auditor, who assigned, when);
  the latest row for a call is in force. A call with none went to every Zone Leader.
- `POST /units/:id/cross-audit` takes `assignments: [{ zoneId, auditorUserId }]` (old
  `zoneIds` / `zoneId` still work). Someone not an active Zone Leader of the Unit → 422.
- `GET /units/:id/cross-auditors` → `[{ userId, fullName, loginId }]` (Coordinator, Super Admin).
- `PUT /units/:id/cross-audits/:roundId/zones/:zoneId/assignee` `{ auditorUserId }` gives a
  Zone to someone else.
- `GET /units/:id/cross-audit-calls`: a Zone Leader sees only calls given to them, plus calls
  given to nobody. Each call and each round Zone carry `assigneeUserId` and `assigneeName`.
- New notice `CROSS_AUDIT_ASSIGNED`, sent only to the assignee.
- Not enforced at sync: anyone's audit of the Zone is still accepted and answers the call.
- Web `CrossAudits.tsx`: each ticked Zone gets a person dropdown; the round card shows who it
  is given to and lets the Coordinator change it.

**Device B (P3):**
- `app/cross-audits.tsx` (Coordinator's call screen): per ticked Zone, a person dropdown from
  `/units/:id/cross-auditors`; every ticked Zone needs a person. Send `assignments`.
- `components/cross-audit-calls.tsx` and `cross-audit-round.tsx`: show "Assigned to you" or
  `assigneeName`; the round card gets "Change auditor" (the PUT above) for a Zone not started.

## 4. Auditee: name and photo (P2 server+web, P3 phone)

When the Zone Leader is away, someone else faces the audit. The auditor records who did, with
a photo, as proof for management. If the Zone Leader is there, they are the auditee.

**Device A (P2):**
- Done in P2: migration `0060` adds `audit_zone.auditee_name` and the `AUDITEE_PHOTO` photo
  kind; `auditeeName` on the audit-zone upsert and on `AuditZone`; the report shows both.
- `packages/domain/src/evidence.ts`: `AUDITEE_PHOTO` → `NEUTRAL` like `AUDITOR_SELFIE`, with
  a test. It does not count toward the Zone's photo limit (`isZoneAuditPhoto` and its server
  twin).
- Contracts and API: the audit-zone create/update request and the sync `audit_zone` upsert
  take an optional `auditeeName`; evidence upload accepts the new kind for that audit zone.
  Optional on the server, because older phones never send it.
- Report payload and template: "Auditee: <name>" plus the photo on the Zone's page; web
  `AuditDetailPanel.tsx` shows both.
- Web conduct (`ConductStart.tsx` / `ZoneRun.tsx`): the same Auditee field and photo.

**Device B (P3):**
- `app/audit/zones/[auditId].tsx`, the form where the Zone is picked: new **Auditee name**
  field, prefilled with the Zone Leader's name (editable), and **Photo of auditee**: live
  camera only, no gallery, reusing `CameraCapture` the way `selfie-check.tsx` does. Both
  required before the questions open (decision D2).
- Local SQLite: the auditee name on the local audit zone (a local schema bump, like the
  existing `v9` notes in `lib/db/schema.ts`), pushed with the `audit_zone` upsert; the photo
  goes through `captureLocalEvidence` with `kind: 'AUDITEE_PHOTO'`.
- Show the auditee on the summary screen.

## 5. Only Super Admin and Coordinator edit Zone Leader and Zone description (P2, P3)

Today every auditor types the Zone description and the Zone Leader's name on the Zone form,
and the typed leader name is written back to the Zone (`app_set_zone_leader_name`, 0015).

**Device A (P2), done in `feat/zone-fields-server`:**
- The server drops `zoneDescription`, `zoneLeaderName` and `zoneLeaderUserId` from anyone but
  a Super Admin or Coordinator (one place, which the sync push also goes through); the snapshot
  takes the Zone's own. Dropped, not refused, so older phones still sync.
- `zone:update` and `zone:assign_leader` were already Super Admin and Coordinator only.
- Web Run an audit: the two fields are read-only for anyone else.
- R-67 conflict: the Coordinator fills in descriptions after a Zone list import.

**Device B (P3):**
- `app/audit/zones/[auditId].tsx`: for a Zone Leader or Consultant, description and Zone
  Leader show as read-only text, and the leader name is no longer a required field. Super
  Admin and Coordinator keep the editable fields. The new Auditee field (§4) is the place
  for "someone else faced this audit".

## 6. Order of work

```
Day 1   A: P2 — 0060, contracts, domain, API, web, DECISIONS R-72…R-76   ┐ in parallel
        B: P1 — photo after score, no catalogue button                   ┘
        B: P1 PR → owner merges (OTA)
Day 2   A: P2 PR → CI green → owner merges (server deploys)
        B: merge origin/main into feat/zone-fields-field, build P3 against the real contracts
Day 3   B: P3 PR → CI green → owner merges (OTA)
```

B can lay out the P3 screens on day 1 against the contract shapes written in this plan, and
wire them up once P2 lands. A pushes P2's contracts commit first so B can read it on GitHub.

## 7. Done means, per PR

- From the repo root, the full CI gate passes (`pnpm -r build`, typecheck, lint, unit
  tests; P2 also the API e2e suite against `audit5s_test`, never the dev database).
- P2: `0060` migrates up on a copy of the dev database; old-style requests (no
  assignments, no auditee, leader typed by a Zone Leader) still succeed.
- P1, P3: tried on the emulator against the branch's API, as a Zone Leader, a Consultant
  and a Coordinator.
- No Prettier. Commit only your own files.

## 8. Decisions

Settled 2026-10-31 and recorded as R-72, R-73 and R-74 in `DECISIONS.md`:

- A Zone Leader **may** be given their own Zone (D9 already allows self cross-audit).
- Only the Unit's Zone Leaders / Auditors can be assigned; Consultants stay hidden from the
  Coordinator (R-64).
- Auditee name and live photo are required on the phone and the web; optional on the server
  for old phones.
- After a Zone list import clears descriptions (R-67), the Coordinator fills them in on the
  Zones page; until then auditors see none.
- The Coordinator reassigns a Zone that is not yet started; assignment is not enforced at sync.
