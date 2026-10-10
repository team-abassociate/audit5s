# Prompt: execute the Kaizen UX plan

Run one block per fresh Claude Code session, **in this order**. Each session stops at its own PR.

| Order | Session | Device | When |
|---|---|---|---|
| 1 | **A1**: shared "what is missing" + discard endpoint | A (`kaizen/krxna`) | now |
| 2 | **1**: Phases 0–3 on the phone, incl. delete draft + required photos | A (`kaizen/krxna`) | after A1 merges into feat/kaizen |
| — | Release N | owner | merge feat/kaizen → main |
| 3 | **A2**: the server enforces photos | A | open any time; **merge only a week after Release N** |
| 4 | **2**: Phase 4 native (motion, haptics, date picker) | A (`kaizen/krxna`) | after Session 1 merges; to main only with the APK |

All four run on **Device A** (this Mac), field app included. The owner decided this on
2026-10-10, overriding the §11 device lanes for this work only. Work from the
`/Users/krxna/main/kaizen` worktree on `kaizen/krxna`. Each session opens its own PR, after
the previous one has merged into `feat/kaizen` (`git pull` first).

---

## Session 1: Phases 0–3 (JavaScript only, ships over the air)

```text
You are the field-app engineer for Leanstack's Kaizen module, and you also have a senior
product designer's eye. Execute plans/kaizen-ux-plan.md, Phases 0, 1, 2 and 3, and nothing
from Phase 4.

READ FIRST, IN THIS ORDER, IN FULL:
1. AGENTS.md, CLAUDE.md, apps/field-mobile/AGENTS.md
2. plans/kaizen-module.md: BRANCH RULE, §5 (builds and OTA), §11 (device lanes)
3. plans/kaizen-ux-plan.md: all of it. It is the spec. Each item names files, the exact
   change and an Accept line.
4. docs/design/GEMBA-BOARD.md §1–§6 and docs/design/gemba-tokens.css (binding for every pixel)
5. The code you will change, end to end, before editing: components/kaizen-form.tsx,
   components/kaizen-card.tsx, app/kaizen/**, lib/kaizen-strings.ts, lib/required-fields.ts,
   components/ui.tsx (Card, Slip, ErrorBanner, ConfirmAction, Field, Segmented),
   components/evidence-photos.tsx (PhotoPreview), lib/db/kaizen.repository.ts.

SKILLS: load these and apply them inside GEMBA-BOARD (GEMBA wins on any conflict):
- emil-design-eng: gate every motion by frequency; feedback on press-in; unseen details.
  The house press is a 3px sink, NOT scale(0.97).
- frontend-design: its "writing in design" rules for every string (an action keeps its
  name through the flow; empty states invite action; errors say what to do). IGNORE its
  palette/typeface/layout invention: the design system is fixed.
- mobile-design: 48dp targets, primary action in the thumb zone, loading/error/offline
  states on every screen.
- rampstack-skills:form-strategy and rampstack-skills:multi-step-form-design: for 2.1–2.3.
- impeccable: run its critique/polish mode on each finished screen, then fix what it finds
  that does not break GEMBA.
- ponytail:ponytail: reuse before writing (useRequiredFields, ConfirmAction, PhotoPreview's
  pattern, Card rail); smallest diff that is correct.

HARD RULES:
- Branch: kaizen/krxna (Device A runs this whole plan, field app included: owner, 2026-10-10). Never commit to, push to, merge to or open a PR against
  main. The PR goes into feat/kaizen.
- This session does not touch packages/contracts, packages/db, packages/domain or apps/api;
  that work is PR A1. PR A1 (missingKaizenItems in @audit5s/domain, the discard endpoint
  and its sync op) must already be merged into feat/kaizen. Check `git log origin/feat/kaizen`
  for it before you start. If it is not there, stop and say so.
- Owner decisions, 2026-10-10, both in scope: before AND after photos are required to
  submit (plan 2.6), and a leader can delete their own draft (plan 2.3). The server does NOT
  enforce the photos yet (that is PR A2, a later release), so the phone is the only guard:
  the engine must hold a submission until both its photos are committed, and that needs a
  test proving a failed upload never dead-letters the submit.
- NO new dependency of any kind in this session. Run
  `node apps/field-mobile/scripts/native-changed.mjs` before the PR; it must report NO
  native change. If anything seems to need a native module, stop and say so.
- Every new or changed string in EN, HI and MR in lib/kaizen-strings.ts. If you are not
  sure of a Hindi or Marathi word, reuse the file's existing vocabulary and list your new
  HI/MR strings in the PR for a native speaker to check.
- Tokens only: no hex literal, no borderRadius, no blurred shadow, no Android elevation.
  One yellow slip per view.
- Never run npx prettier. Edit by hand.
- Do not "fix" owner rulings: green = Approved only; module switch lives on Profile; sync
  bar only on tab main pages; the step order follows the client's paper Kaizen Sheet.
- Do not commit until you have verified on the emulator AND run the full CI gate from the
  repo root. Then commit only your own files, authored with the repo's configured identity.

PROCESS:
1. Phase 0 on the emulator (local stack + dev client). Record the 0.1 and 0.2 results with
   screenshots, and take the 0.3 "before" set. Phase 0 decides whether 2.4 and 3.4 run.
   Report the results before moving on.
2. Phases 1 → 2 → 3, in plan order. After each numbered item, check its Accept line on the
   emulator. Keep a running checklist in output/kaizen-ux-2026-10-10/progress.md (item, done
   / skipped + why, evidence).
3. Phase 5 steps 1–5 for this PR: unit tests for the new pure helpers, Maestro
   .maestro/kaizen.yaml updated and passing end to end, the full CI gate, "after" screenshots
   (light/dark, EN/MR), and the GEMBA acceptance checklist on every touched screen.
4. Open ONE PR into feat/kaizen. Title: "feat(kaizen): UX pass: guided form, honest overview,
   review flow". Body: the findings table with each row's outcome (fixed / no change needed /
   deferred + why), before/after screenshot pairs, the Phase 0 evidence, the native-changed
   output, the HI/MR strings for review, and anything you chose not to do and why.

Stop after opening the PR. Report: what shipped, what was skipped and why, anything that
surprised you, and the PR link.
```

---

## Session 2: Phase 4 (native: motion, haptics, date picker; needs a new APK)

Run only after Session 1's PR has merged into `feat/kaizen`.

```text
You are the field-app engineer for Leanstack's Kaizen module. Execute
plans/kaizen-ux-plan.md Phase 4 (and Phase 5 steps 6–7), on top of feat/kaizen with the
Phase 1–3 PR already merged.

OWNER APPROVAL: on 2026-10-10 the owner approved adding react-native-reanimated,
react-native-worklets, react-native-gesture-handler, expo-haptics and
@react-native-community/datetimepicker. This makes the release a NEW APK that every client
phone must install. The approval covers exactly these packages. If you think you need
anything else native (e.g. react-native-keyboard-controller), stop and ask.

READ FIRST, IN FULL: AGENTS.md; apps/field-mobile/AGENTS.md; plans/kaizen-module.md §5 and
§11; plans/kaizen-ux-plan.md (the whole file, Phase 4 closely); plans/002-reduced-motion.md,
003-press-token.md, 005-arrival-transition.md; docs/design/GEMBA-BOARD.md §2 and §8;
gemba-tokens.css (--motion, --press); then every file Phase 4 names.

SKILLS: load animate-expo and expo-animation (motion on the UI thread, springs for fingers,
reduced motion, haptics rules), emil-design-eng (the frequency gate, ease-out, interruptible
springs, asymmetric enter/exit), apple-design (the photo viewer's pinch, pan and
swipe-to-dismiss feel), react-native-expert and vercel-react-native-skills (no re-renders
per frame). GEMBA overrides them on looks: 143ms, ease-out, a 3px press sink, no scale-to-zero,
no blur, no radius.

HARD RULES:
- Install with `npx expo install …` only, exactly the five packages above.
- In the SAME commit: app.config.ts version 0.1.0 → 0.2.0. Do NOT edit native-baseline.txt.
- Never run `eas build` or `eas update`. Building and handing out the APK is the owner's
  release-day step. For feel checks, build a local release APK (see the local dev notes in
  plans/kaizen-module.md and the repo's dev docs).
- Reanimated only via lib/motion.ts constants (143ms, Easing.bezier(0.23, 1, 0.32, 1),
  ReduceMotion.System). No setState in gesture/scroll handlers, no scheduleOnRN in onUpdate,
  .get()/.set() on shared values, never read a shared value during render.
- Haptics at exactly the five moments in plan 4.4, each paired with its visual. Nowhere else.
- Motion only for M1–M6. Anything the plan lists as "rejected on purpose" stays rejected.
- M1 changes shared components in ui.tsx, which 5S uses too: run the 5S Maestro flows as a
  regression.
- Every Phase 4 behaviour must be an enhancement: the screen already works without it
  (Phase 1–3). Nothing may depend on a haptic or an animation finishing.
- Branch rules as always: never main; PR into feat/kaizen. No Prettier. Verify on device and
  run the full CI gate before committing.

PROCESS:
1. 4.1 packages + GestureHandlerRootView + version bump. Run native-changed.mjs: it MUST
   report a native change. Build a local release APK, install it, and make sure the app
   launches and an existing 5S audit and a Kaizen still work before adding any motion.
2. 4.2 tokens, then M1 → M6 one at a time, then 4.4 haptics, then 4.5 date picker. After each,
   feel-check on the release APK on the slowest AVD/phone you have, with the system
   "Remove animations" setting on and off.
3. Phase 5 step 7 feel checks, written up item by item (what you tried, what you changed).
   Maestro kaizen.yaml updated for the date picker and passing; 5S flows passing; full CI gate.
4. Open ONE PR into feat/kaizen titled "feat(kaizen): motion, haptics and date picker
   (NEEDS NEW APK)". First line of the body, bold: "This PR changes the native layer. Merge
   to main only on the day the 0.2.0 APK is handed out; until then old phones get no OTA
   updates." Then: the native-changed output, the package list with versions, the motion
   table (M1–M6) with what was built, the haptics list, the rejected-on-purpose list, and
   short screen recordings of the photo viewer and the submit flow.

Stop after opening the PR and report.
```

---

## Session A1: shared "what is missing" + delete draft, server half (first)

```text
You are Device A for Leanstack's Kaizen module; this whole UX plan runs on Device A. Implement
plans/kaizen-ux-plan.md Phase X items X.1 and X.2. NOT X.3; that is a later PR.

Owner decisions, 2026-10-10: (#20) a before photo and an after photo are required to submit
a Kaizen; (#21) a Zone Leader can delete (discard) their own draft. Read the plan's "Why
required photos ship in two releases" before anything else. In this PR the server must NOT
start refusing photo-less submissions; phones still on today's JavaScript would dead-letter.

READ FIRST: AGENTS.md, STACK.md, DECISIONS.md in full; ARCHITECTURE.md by section only (grep
for the Kaizen state machine and the sync protocol); plans/kaizen-module.md BRANCH RULE and
§11; plans/kaizen-ux-plan.md (Phase X, 2.3, 2.6); then packages/contracts/src/kaizen.ts,
packages/domain/src/kaizen.ts, packages/domain/src/sync-policy.ts,
packages/domain/src/state-machine.ts, packages/db/src/schema/kaizens.ts,
packages/db/migrations/0044_a_zone_leader_records_a_kaizen.sql,
apps/api/src/modules/kaizens/*, and the sync batch handler for kaizen items.

SKILLS: ponytail:ponytail (smallest correct diff; reuse what is there),
supabase-postgres-best-practices as plain-Postgres advice for the migration and triggers,
domain-modeling for the DECISIONS.md entry and the glossary.

BUILD:
- X.1: missingKaizenItems(sheet, { before, after }) in packages/domain, with tests.
  missingKaizenFields unchanged.
- X.2: migration kaizen.discarded_at (soft; triggers refuse discarding a non-DRAFT and
  any write to a discarded row); POST /kaizens/{id}/discard (author, DRAFT only,
  idempotency key, guard chain, scope predicate, 200 no-op when already discarded); the sync
  op the phone will send (`kaizen` + `discard`) in contracts and its place in sortSyncItems;
  a sync upsert to a discarded Kaizen accepted as a no-op; every list, count, dashboard,
  analysis and export excludes discarded rows. Tests for each rule: db triggers beside
  kaizen-schema.test.ts, api beside the module, sync ordering in sync-policy.test.ts.
- One DECISIONS.md entry recording both owner decisions, including the two-release rollout
  for the photo rule.

RULES: branch kaizen/krxna → PR into feat/kaizen; never main. Never define a shared type
twice. Idempotency on the new endpoint. Nothing hard-deleted. No Prettier. Full CI gate from
the repo root before committing; commit only your own files.

Stop at the PR. Post its link and the exact exported names (function, types, sync op) the phone
session will import.
```

---

## Session A2: the server enforces the photos (Release N+1)

Open any time after A1. **Merge into `feat/kaizen` only once Release N has been on phones
for a week.**

```text
You are Device A for Leanstack's Kaizen module. Implement plans/kaizen-ux-plan.md item X.3:
the server and database refuse a move to SUBMITTED without a committed, non-deleted before
photo AND after photo (owner decision #20, 2026-10-10).

Read the plan's Phase X in full first, especially "Why required photos ship in two
releases". Then kaizens.service.ts (submit), state-machine.ts (KAIZEN_TRANSITIONS), the
kaizen and kaizen_photo schema and migrations, seed-sample-kaizens.ts.

BUILD: the submit check uses missingKaizenItems (from PR A1), with field errors
beforePhoto / afterPhoto; a new guard kaizen_photos_complete on DRAFT→SUBMITTED and
SENT_BACK→SUBMITTED; a DB trigger enforcing it on that transition only (existing
SUBMITTED/APPROVED/REJECTED rows without photos stay valid); the seed gives every non-DRAFT
sample Kaizen both photos. Tests for each.

RULES: kaizen/krxna → PR into feat/kaizen, never main. First line of the PR body, bold:
"Merge into feat/kaizen only after Release N (the phone-side photo rule) has been on phones
for at least a week." Full CI gate before committing. Stop at the PR.
```
