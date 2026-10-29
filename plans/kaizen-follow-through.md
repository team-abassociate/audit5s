# Kaizen follow-through (2026-10-29)

Owner asked to check the Kaizen module against three "good kaizen system" feature lists and
build what is missing. Most of those lists is already built (one-sheet capture, before/after
photos from camera or gallery, PQCDSM + 8 wastes, 4M root cause, 7 QC tools, saving and cost,
offline drafts, Hindi/Marathi UI, one Coordinator review with a required reason, review
history, audit log, KPI/funnel/trend/departments dashboard, department/zone table, A4 PDF
sheet, per-person access). Owner chose these four gaps:

1. **Alerts + waiting time.** Coordinator told when a Kaizen is submitted; author told when
   it is approved, sent back or rejected. Pending cards and the Coordinator's Overview show
   how many days a Kaizen has waited.
2. **Management numbers.** Participation (% of the Unit's Kaizen Zone Leaders who submitted
   in the period), average days from first submission to first decision, top 5 contributors
   (approved count and approved saving).
3. **30/60/90-day sustain check** — owner chose *Coordinator alone*: at 30, 60, 90 days
   after approval the Kaizen is in the Coordinator's "Checks due" list; they record
   "Still in place" or "Not in place" (a note required for the second), online. Not in
   place alerts the author.
4. **Excel register.** Every Kaizen in scope, with the list's filters, as one .xlsx (web).

## Rules this follows

- **No state-machine change.** APPROVED stays terminal; a sustain check is its own
  append-only row (`kaizen_sustain_check`), so the transition trigger and the phone's outbox
  are untouched. Recording one is `kaizen:review` (no new permission).
- **A check covers the latest mark that has passed.** A Coordinator who first looks at day
  65 records the 60-day check; the 30-day one is missed, not owed. Only the due mark may be
  recorded (server-enforced), once (unique per Kaizen and mark).
- **Waiting since = `updatedAt` of a SUBMITTED Kaizen.** 0044's trigger lets nothing but the
  status change on a SUBMITTED row, so its `updated_at` is the moment it was (re)submitted.
  No new column.
- **Kaizen alerts reach only people holding Kaizen** (R-57): `app_notification_targets`
  filters `KAIZEN_*` events on `kaizen_access`.
- **The register streams from the API** like the checklist error report (small, scope-checked
  on the request that makes it).
- Counting stays in `packages/domain`; clients render what the API sends.

## Steps (one PR, `kaizen/krxna` → `main`)

1. contracts: event types, sustain check shapes, `nextSustainCheck` on `Kaizen`,
   `sustainDue` list filter, dashboard `people` + `sustain` blocks.
2. db: migration 0059 (table, RLS, append-only, notification-target filter), Drizzle schema.
3. domain: `nextSustainCheck`, `kaizenWaitingDays`, participation / cycle time / top
   contributors / sustain counts in `kaizenDashboard`.
4. api: emit the three events, sustain-check endpoint, facts + eligible leaders, register
   xlsx, `sustainDue` filter, notification wording.
5. web: waiting days on pending rows, people + sustain tiles on Overview/Analysis, "Checks
   due" + record check in the panel, Download Excel on the list.
6. phone (OTA, JS only): waiting days on cards, Checks due on the Coordinator Overview,
   record check on the detail, sustain history on detail, Analysis numbers.
7. DECISIONS.md R-69.

Not built (ponytail): points/badges, QR codes, duplicate detection, Yokoten tracking,
multi-level approval, kaizen events, WhatsApp templates for Kaizen, nightly "check due"
reminder (the Overview list is the reminder until it measurably is not enough).
