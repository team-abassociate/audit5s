# Kaizen field app — UX plan (2026-10-10)

> **Branch rule (owner, 2026-10-10):** PRs go from `kaizen/krxna` straight into `main`.
> Merging into `main` is a release (it deploys), so it happens only with the owner's go
> ([`kaizen-module.md`](kaizen-module.md), BRANCH RULE).

The prompt that runs this plan is [`kaizen-ux-prompt.md`](kaizen-ux-prompt.md). This file is
the plan: what is wrong, why, the exact change, and how to prove each one.

Two audits feed it:

- **Pass 1** (2026-10-10): Nielsen heuristics + a cognitive walkthrough of "a first-time Zone
  Leader submits a Kaizen, then fixes one that was sent back". Findings **#1–#19**.
- **Pass 2** (2026-10-10, same day): a skill-led re-audit with `emil-design-eng`,
  `frontend-design`, `mobile-design` and `animate-expo`. Findings **S1–S12**, plus the motion
  and haptics layer (**M1–M8**).

Both were static reviews of the code at `58cc105` (no device run). Phase 0 checks the two
findings that need a device before anything is fixed.

---

## 0. Ground rules

| Rule | Where it comes from |
|---|---|
| **All of this plan runs on Device A** (`kaizen/krxna`), field app included: the owner's call, 2026-10-10, overriding the §11 lanes for this work only. Keep the server PRs (A1, A2) and the phone PRs (B1, B2) separate anyway: they ship at different times. | Owner, 2026-10-10; `kaizen-module.md` §11 |
| GEMBA-BOARD is binding: no radius, no blurred shadow, tokens only, **one yellow slip per view**, status = shape + colour, **48dp targets**, confirmations are a slip in the words of what happened, destructive actions use `ConfirmAction` (never `Alert`). | `docs/design/GEMBA-BOARD.md` §2, §6; `apps/field-mobile/AGENTS.md` |
| **Motion token: 143 ms, ease-out only. Press = 3 px sink + shadow collapse**, not `scale(0.97)`. Emil's scale-on-press is overruled by the house press; his *principles* (gate by frequency, ease-out, interruptible, reduced motion = gentler not none, feedback on press-in) apply in full. | `gemba-tokens.css` `--motion`, `--press`; `plans/003-press-token.md` |
| Green = Approved only; ink (not green) for a done step. | Owner, 2026-10-07 (comment in `kaizen-form.tsx`) |
| Module switch stays on Profile; sync bar on tab main pages only. | Owner, 2026-10-09 |
| Every string in **EN, HI and MR** (`lib/kaizen-strings.ts`). No English-only copy. | Existing convention |
| **No Prettier.** Edit by hand. | memory: no-prettier |
| **Never commit without being told.** Verify on the emulator first; run the full CI gate from the repo root. | memory: verify-before-committing |
| **Native libraries are approved** (owner, 2026-10-10: "add them then"): Reanimated + worklets, gesture-handler, expo-haptics, and the native date picker in the same APK. **Phase 4 only.** | memory: kaizen-native-libs-approved |

### Why the native work is last and in its own PR

Phases 1–3 are JavaScript only. They reach every phone **over the air** the day the owner
releases, with no reinstall. Phase 4 changes the native layer:

- `scripts/native-changed.mjs` will see it, and `deploy.yml` will **stop publishing OTA
  updates** to the old APK's runtime.
- Phase 4's PR **must bump `version` in `app.config.ts`** (0.1.0 → 0.2.0) in the same commit
  that adds the packages. With `runtimeVersion: { policy: 'appVersion' }`, that bump is what
  stops a bundle that imports Reanimated from ever being sent to a 0.1.0 phone, where it
  would crash on launch.
- Building the APK (`eas build --profile vps`), handing it out and updating
  `native-baseline.txt` are the **owner's release-day steps**. No agent runs `eas build` or
  `eas update` by hand.
- Until a phone installs 0.2.0, it keeps the Phase 1–3 behaviour. Every Phase 4 item must
  therefore be an **enhancement on top of a working Phase 1–3 screen**, never the only way
  something works.

---

## 1. Findings register

Severity: **Critical / Major / Minor / Cosmetic**. Phase = where it is fixed.

### Pass 1

| # | Screen · element | Problem | Sev | Phase |
|---|---|---|---|---|
| 1 | Leader Overview · stat grid | "Last 30 days" heading, but Pending and Returned are all-time; the numbers do not add up | Major | 1 |
| 2 | Leader Overview · first section | Rejected Kaizens (final, nothing to do) sit forever in the "needs you" section | Major | 1 |
| 3 | Leader Overview · empty state | First text a new user reads is "Nothing returned by the Coordinator" | Minor | 1 |
| 4 | Form · text boxes | Saved on blur only: Back or a killed app while typing may lose the box (**verify first**) | Major* | 0 → 2 |
| 5 | New tab | Always blank; drafts are not offered; duplicates pile up; no delete | Major | 2 |
| 6 | Form · Remove photo | One tap, no confirm; the "before" condition cannot be photographed again | Major | 1 |
| 7 | Form · labels | [5W1H], [4M], [7 QC tools], "Horizontal deployment" have no explanation | Major | 1 |
| 8 | Form · step header | Required and Optional look identical (11px ink-3) and stay identical after a failed Submit | Major | 2 |
| 9 | Form · step 12 | Idea by / Implemented by are usually the leader; retyped at peak fatigue | Minor | 1 |
| 10 | Form · date | Typed as YYYY-MM-DD | Minor | 4 |
| 11 | After Submit | `submittedNote` exists in 3 languages and is never shown: no confirmation | Major | 1 |
| 12 | Card · number | "Number on sync" is system language | Minor | 1 |
| 13 | Card · photo tags | 9px | Minor | 1 |
| 14 | Detail · Edit & resubmit | Button sits under ~15 rows; the reason is at the top | Major | 1 |
| 15 | Detail · review | After Confirm the screen just closes: no confirmation, no next item | Minor | 3 |
| 16 | Kaizens · status filter | 5 one-line segments on 360dp; may truncate in HI/MR (**verify first**) | Minor* | 0 → 3 |
| 17 | Everywhere · status words | Pending / Awaiting review / awaiting your review; Returned / Sent back | Minor | 1 |
| 18 | Module switch | Hidden in Profile once a module is remembered (owner ruling stands) | Minor | 3 |
| 19 | Tab icons | Unicode glyphs render differently per Android font | Cosmetic | 3 |

### Pass 2 (skill-led)

| # | Lens | Screen · element | Problem | Sev | Phase |
|---|---|---|---|---|---|
| S1 | Consistency (Nielsen 4) | Form · Submit validation | Every other form in the app uses `useRequiredFields` (`lib/required-fields.ts`): marks each missing field red, scrolls to the first, focuses it. Kaizen invented a step-level slip instead, so the leader learns which *step* is empty but not which *box* | Major | 2 |
| S2 | Thumb zone (`mobile-design`) | Form · Submit | The only primary action is below 12 cards, off screen for the whole fill. There is no sense of progress | Major | 2 |
| S3 | One slip per view (GEMBA §2.7) | Form, resubmitting | The "Sent back" slip and the "Fill these" slip can both show at once. Two slips = nothing is urgent | Minor | 2 |
| S4 | Reviewer's core job | Detail · photos | Before/After are ~165dp squares and cannot be opened. The Coordinator judges the Kaizen from these photos | Major | 3 (view), 4 (pinch-zoom) |
| S5 | Feedback on press-in (Emil) | Form · step headers | No pressed state at all; every other pressable sinks | Minor | 2 |
| S6 | Destructive weight (`mobile-design`) | Detail · review buttons | Reject has the same weight as Approve; "Confirm: Reject" names the dialog, not the action | Minor | 3 |
| S7 | Accessibility | Form · missing-fields notice | Appears at the top with no live region; a TalkBack user is not told Submit was refused | Minor | 2 |
| S8 | Copy (`frontend-design`: "an empty screen is an invitation to act") | History, Kaizens, Overview empties | Statements, not directions: "Your Kaizens will appear here." | Minor | 1 |
| S9 | Copy | Photo placeholder "Shown online"; `needsConnection` says "figures" on lists and on the detail | Says what the system does, not what the person sees | Minor | 1 |
| S10 | Motion gate (Emil) | Form · Next | `setTimeout(60)` then scroll to a y measured *before* the collapse; the screen lurches | Minor | 2 |
| S11 | Motion token | `kaizen-charts.tsx` bars | 220ms; the system has one duration, 143ms | Cosmetic | 3 |
| S12 | Status = shape (GEMBA §2.8) | Form · step state | "Done" has a ✓ shape; "Required" is just a word | Minor | 2 (with #8) |

### Owner decisions, 2026-10-10

| # | Decision | Phase |
|---|---|---|
| 20 | **A before photo and an after photo are required to submit** (and to resubmit). Today both are optional, yet the card leads with the pair and shows "Before · none". | X.1 (A), 2.6 (B), X.3 (A, next release) |
| 21 | **A leader can delete (discard) their own draft.** | X.2 (A), 2.3 (B) |

Both are recorded in `DECISIONS.md` as one new R-entry (PR A1).

---

## 2. Design direction (what the skills add, inside GEMBA)

This is not a restyle. The board look stays: hard edges, hard shadows, Archivo + DM Mono, tape,
slip. The skills add **behaviour** and **finish**:

1. **The form becomes a guided job with its end always in view.** A sticky footer above the
   tab bar shows progress ("7 of 12 · 3 required left") and the primary action. (`mobile-design`
   thumb zone; Nielsen 1 visibility.)
2. **Every refusal points at a box, not a step.** Reuse `useRequiredFields`: red box, scrolled
   into view, cursor in it. (Consistency; S1.)
3. **Every action says what happened, once, in its own words.** "Submit Kaizen" produces
   "Kaizen submitted". "Approve Kaizen" produces "Approved KZ-…". (`frontend-design`: an
   action keeps its name through the flow; GEMBA §6 Confirmation.)
4. **Specialist vocabulary is explained where it is asked.** Hints under the box, in the
   leader's language. (Nielsen 2, 10.)
5. **Motion only where it carries meaning.** Gate every animation by how often it is seen
   (Emil). Tabs: never. Step open/close: barely. Submit success, arrival of the new card,
   photo viewer: yes. All at 143ms ease-out `Easing.bezier(0.23, 1, 0.32, 1)`. Reduced motion
   keeps opacity and colour and drops travel.
6. **Haptics are rare and always paired with a visual.** Five moments in the whole module
   (M7). Never on scroll, never on checkboxes, never as the only signal.

### Status vocabulary (#17), one word per state, everywhere

| State | Chip | Section / stat | Picker |
|---|---|---|---|
| `DRAFT` | Draft | Drafts | "N drafts not submitted" (unchanged) |
| `SUBMITTED` | **Waiting** | **Waiting for review** | "awaiting your review" → **"waiting for your review"** |
| `SENT_BACK` | Sent back | **Needs your fix** (leader) / Sent back (filter) | "sent back to you" (unchanged) |
| `APPROVED` | Approved | Approved | — |
| `REJECTED` | Rejected | Rejected | — |

Translators: keep HI/MR consistent with the same one-word-per-state rule. Reuse the existing
HI/MR words where the English is unchanged.

---

## Phase X — server half of the owner decisions

The phone work imports from `packages/domain` and `packages/contracts`, so these come first.

### Why required photos ship in two releases

A submission is queued on the phone and sent later (`lib/sync/engine.ts`): the submit rides the
last pass, after the media pass, and is sorted after the photo `commit`. But on a weak
connection the photo's PUT fails, its `commit` is never queued, and the `submit` still goes.
If the **server** demands photos from day one:

- phones still running today's JavaScript (an OTA update lands only on the next cold start)
  submit photo-less Kaizens; the server refuses them with a 4xx; a non-retryable 4xx is
  **dead-lettered**. The leader sees "Pending" on the phone while the server holds a DRAFT.
- even on the new JavaScript, a submit can overtake its own photo upload, with the same result.

So:

1. **Release N** (this plan): the phone requires the photos before it will submit, and **holds
   a queued submission until both of that Kaizen's photos are committed** (X.1, 2.6). The
   server is unchanged on this point.
2. **Release N+1** (at least a week later, once every phone has opened the app): the server
   and the database enforce it too (X.3). By then no phone can send a photo-less submit.

### X.1 One shared "what is missing" (Release N)
- `packages/domain/src/kaizen.ts`: add
  `missingKaizenItems(sheet, photos: { before: boolean; after: boolean })` →
  `[...missingKaizenFields(sheet), ...(photos.before ? [] : ['beforePhoto']), ...(photos.after ? [] : ['afterPhoto'])]`.
  Keep `missingKaizenFields` as it is (the server and the DB constraint use it).
  Export a `KaizenMissingItem` type from contracts if it crosses an app boundary.
  Unit tests beside `kaizen.test.ts`.
- The phone (2.6) and, in Release N+1, the server (X.3) both call it, so they cannot disagree.

### X.2 Discard a draft (Release N)
- Migration (next number after 0044): `kaizen.discarded_at timestamptz NULL`. Soft only; the
  no-hard-delete rule stands. Triggers: discarding a non-DRAFT row is refused; any write to a
  discarded row is refused. Its photos stay as they are (they are already soft-deletable via
  `kaizen_photo.deleted_at`).
- `POST /kaizens/{id}/discard`: author only, DRAFT only, idempotency key, the global guard
  chain, the repository scope predicate. Discarding an already-discarded draft is a 200 no-op
  (the phone retries).
- Every list, count, dashboard, analysis and export query excludes discarded rows. A sync
  `upsert` for a discarded Kaizen is accepted as a no-op, not an error (an old queued edit must
  not dead-letter).
- Contracts: the sync item / outbox op the phone sends (`kaizen` + `discard`), and its
  place in `sortSyncItems` (`packages/domain/src/sync-policy.ts`): after any `upsert` of the same Kaizen.
- DB trigger tests beside `kaizen-schema.test.ts`; API tests beside the module.
- The admin portal never shows a discarded draft (it lists no DRAFTs today; confirm).

### X.3 The server enforces the photos (Release N+1, separate PR, merged only after Release N is out)
- `kaizens.service.ts` submit: replace the `missingKaizenFields` check with
  `missingKaizenItems(sheet, { before, after })`, where a photo counts only if its row
  exists, is not deleted, and its upload is committed. Field errors `beforePhoto` / `afterPhoto`
  so a client can mark the step.
- New guard `kaizen_photos_complete` on `DRAFT → SUBMITTED` and `SENT_BACK → SUBMITTED`
  in `KAIZEN_TRANSITIONS` (`packages/domain/src/state-machine.ts`).
- DB: a trigger refusing the move to `SUBMITTED` without both committed, non-deleted photos.
  **Only on that transition**: Kaizens already SUBMITTED/APPROVED/REJECTED without photos stay
  valid. A SENT_BACK one without photos needs them on resubmit, as intended.
- `apps/api/src/seed-sample-kaizens.ts`: give every seeded non-DRAFT Kaizen both photos, or the
  seed breaks.
- PR body: "Merge into main only after Release N has been on phones for a week."

---

## Phase 0 — check before fixing (emulator, ~30 min)

Run the local stack and the Leanstack dev client as `kaizen-module.md` §5 and the
`local-dev-environment` memory describe.

**0.1 — #4 save-while-typing.** As a seed Zone Leader: New Kaizen → type in *Machine* → don't
leave the box → press system Back twice (or switch tab, then force-stop the app with
`adb shell am force-stop in.abassociate.audit5s`) → reopen → open the draft.
Record: is the text there? Repeat on the Edit route (stack screen, unmounts on Back).
- Lost → #4 is **Major, confirmed**; do 2.4.
- Kept in all cases → mark #4 *no change needed* in the PR description, and skip 2.4.

**0.2 — #16 filter truncation.** As the Coordinator, Profile → language Marathi, then Hindi →
Kaizens tab on a 360×800 AVD. Screenshot. Truncated (ellipsis) → do 3.4; otherwise skip it.

**0.3 — Baseline screenshots** of Picker, Leader Overview, New Kaizen (closed + open step),
Detail (sent back), Coordinator Overview, Kaizens, Analysis, in light and dark. Save under
`output/kaizen-ux-2026-10-10/before/`. Phase 5 retakes the same set as `after/`.

---

## Phase 1 — quick wins (JS only, OTA)

Each item lists files and the exact change. All strings go in EN/HI/MR.

### 1.1 Confirm the submit (#11)
- `app/kaizen/(tabs)/new.tsx` and `app/kaizen/edit/[kaizenId].tsx`: navigate with a param,
  `router.navigate({ pathname: '/kaizen/overview', params: { submitted: kaizenId } })`.
  `KaizenForm.onSubmitted` already fires after a successful submit. Pass it the id
  (`onSubmitted(kaizenId)`).
- `overview.tsx` `LeaderOverview`: read `useLocalSearchParams<{ submitted?: string }>()`. When
  set, render the screen's **one** slip at the top:
  `<Slip title={t.submittedTitle}><SlipText>{t.submittedNote}</SlipText></Slip>`.
  New string `submittedTitle` = "Kaizen submitted". Keep `submittedNote` as is ("It reaches
  your Coordinator when there is signal."). That is the honest §9.9 wording: saved ≠ sent.
- Clear it: `router.setParams({ submitted: undefined })` on the next pull-to-refresh or when the
  screen loses focus (`useFocusEffect` cleanup), so it does not come back on every visit.
- Resubmit uses `t.resubmittedTitle` = "Kaizen resubmitted".
- **Accept:** submit offline → Overview shows the slip; the card is in "Waiting for review" with
  "Not sent yet". Leave and return → the slip is gone.

### 1.2 Sent-back card opens the form (#14)
- `components/kaizen-card.tsx` `kaizenHref`: route `SENT_BACK` to `/kaizen/edit/[kaizenId]`, like
  `DRAFT`. The form already shows the Coordinator's reason as a slip.
- **Only for the leader's own list.** `kaizenHref` is only used with local Kaizens; the
  Coordinator's lists push to the detail directly. Check that every caller of `kaizenHref`
  is the leader's (grep).
- Detail screen: keep the Edit & resubmit button for anyone who arrives there, but move it
  **directly under the slip**, above the sheet card.
- **Accept:** a Sent back card → form with the reason on top; Back → Overview.

### 1.3 Overview: honest numbers, actionable top section (#1, #2, #3)
- `overview.tsx` `LeaderOverview`:
  - `returned` → `needsFix = all.filter(k => k.status === 'SENT_BACK')`.
  - Stats, under the heading "Last 30 days": **Submitted** (recent), **Approved** (recent),
    then a second `StatGrid` row or a renamed pair under a new `SectionHead` "Now":
    **Waiting** (`awaiting.length`) and **Needs your fix** (`needsFix.length`). Two headings,
    each telling the truth about its window.
  - First section: "Needs your fix" with `needsFix`. Hide the whole section when empty
    (it is an action list, not a report).
  - Rejected: only in History. Approved section keeps its 30-day window.
  - **Zero-Kaizen state** (`all.length === 0`): replace every section below the button with
    one `EmptyState` titled `t.firstKaizenTitle` = "Record your first Kaizen", detail
    `t.firstKaizenDetail` = "One improvement: the problem, what you changed, and photos
    before and after. Your Coordinator reviews it." Hide the stat grid too (four zeros teach
    nothing).
- **Accept:** seed data with one rejected and one sent back → only the sent-back one is at the
  top; the stats add up under their headings.

### 1.4 Confirm before Remove photo (#6)
- `kaizen-form.tsx` `photoStep`: replace the Remove `Button` with
  `<ConfirmAction title={t.removePhoto} question={t.removePhotoQuestion(kind)} confirmLabel={t.removePhoto} busy={removePhoto.isPending} onConfirm={() => removePhoto.mutate(shown.id)} />`.
  `ConfirmAction` (`components/ui.tsx:1008`) is the house pattern: danger outline, asks in
  place, "Keep" / confirm.
- `removePhotoQuestion`: BEFORE → "Remove the before photo? If the problem is already fixed,
  it cannot be photographed again." AFTER → "Remove the after photo?"
- **Accept:** one tap does not delete; Keep cancels; confirm deletes.

### 1.5 Explain the specialist words (#7)
- `kaizen-form.tsx` `textField`: pass `hint={t.hint[field]}` when present (the `Field` `hint`
  prop exists and hides itself when there is an error).
- New `hint: Partial<Record<KaizenTextField, string>>` in `KaizenStrings`:
  - `theme`: "One line: what you improved. e.g. Quick-release clamps on the P-04 die"
  - `problem5w1h`: "What, where, when, who, which and how. e.g. Die change on P-04 takes 40 min because…"
  - `rootCause4m`: "Man, machine, method or material: which one caused it, and why?"
  - `analysis7qc`: "Optional. e.g. Pareto chart, fishbone, check sheet"
  - `benefits`: "What changed, in numbers if you have them. e.g. Changeover 40 → 12 min"
  - `teamMembers`: drop "Names, comma separated" from the label; label "Team members", hint
    "Names, separated by commas".
- Rename the step `horizontal` to the question itself: "Use on other machines?" (and HI/MR).
  Remove the now-duplicate `Label` above the Yes/No list, or keep it as the longer question.
- **Accept:** each hint visible under its box; an error replaces it.

### 1.6 Prefill the people (#9)
- `kaizen-form.tsx` initial texts for a **new** Kaizen only (`id === null` branch of the
  `useEffect`): `ideaBy: user.fullName`, `implementedBy: user.fullName`.
- **Careful:** a prefilled value is not saved until blur/submit. `pendingTextFields()` already
  flushes on Submit, so prefill is safe. It must **not** create a draft on open (the "opening and
  leaving creates nothing" rule). Do not call `save` from the effect.
- **Accept:** a new form shows the leader's name in both boxes; opening and leaving New creates
  no draft (check `localKaizenCounts`).

### 1.7 Copy and small type (#12, #13, #17, S8, S9)
- `numberOnSync` → "Not sent yet".
- `kaizen-card.tsx` `tagText.fontSize` 9 → `theme.font.label` (11); `letterSpacing` 1.2 → 0.9
  so "BEFORE · NONE" still fits a 118px half.
- Status words per the table in §2.
- `historyEmpty` → "No Kaizens yet. Record your first from New Kaizen."
- `queueEmpty` stays.
- `photoOnline` → "Photo loads when you're online".
- Split `needsConnection`: keep it for Analysis/Overview figures; add `listNeedsConnection` =
  "This list needs a connection. Pull down to try again." and `kaizenNeedsConnection` =
  "This Kaizen needs a connection to open." Use them in `kaizens.tsx` and `[kaizenId].tsx`.
- `confirm(decision)` → action names: "Approve Kaizen", "Send back", "Reject Kaizen" (S6 copy half).

---

## Phase 2 — the form, rebuilt as a guided job (JS only, OTA)

`components/kaizen-form.tsx` is the whole of this phase. Read it end to end first; its
comments explain the save serialisation (`saving` ref, `idRef`), and nothing here may break it.

### 2.1 Required fields the house way (S1, #8, S12, S7)
- Adopt `useRequiredFields<KaizenTextField | 'horizontalDeployment'>()` (`lib/required-fields.ts`):
  - `ref={required.scroll}` on the `ScrollView`.
  - `inputRef={required.input(field)}` and
    `error={required.error(field, t.requiredError, !missingNow.has(field))}` on each required
    `Field`.
  - `ref={required.anchor('horizontalDeployment')}` + `collapsable={false}` on the Yes/No wrapper.
- **The accordion problem:** a field in a closed step is not mounted, so it cannot be scrolled
  to. On Submit with gaps: `setOpen(index of the first missing step)`, then call
  `required.check(...)` **after** that step has laid out (inside the opened step's `onLayout`,
  or `requestAnimationFrame` twice). Read `check`/`reveal` in `required-fields.ts` first and
  follow its timing constants (`FOCUS_DELAY_MS`); do not invent new ones.
- Step headers:
  - `required` and not yet attempted: "REQUIRED" in `ink` (not ink-3), medium weight.
  - `required` after a failed Submit: `<Card rail="crit">` (the house 4px severity rail,
    `ui.tsx` `Card`) plus the word in `crit`.
    Shape + colour (GEMBA §2.8).
  - `optional`: unchanged ink-3.
  - `done`: unchanged "✓ Done" in ink.
- Replace the "Fill these before submitting" **slip** with an `ErrorBanner` (crit rail,
  `accessibilityRole="alert"`, a live region): "3 required boxes are empty: Problem, Root
  cause, Implemented by." That frees the slip for the Sent back reason (S3), and TalkBack reads
  it (S7).
- `submitLocalKaizen` keeps its own guard; do not remove it.
- **Accept:** Submit with Problem and Root cause empty → step 04 opens, the Problem box is red,
  in view and focused; step 12 has a crit rail; the banner names both; TalkBack announces it.

### 2.2 Sticky progress footer (S2)
- Move the Submit button out of the `ScrollView` into a footer `View` pinned above the tab bar
  (the form screen is `Screen bare`; the footer is a sibling after the `ScrollView`, inside a
  `flex: 1` column).
- Footer anatomy (GEMBA magnet style; tokens only):
  `[ progress meter ] 7 of 12 · 3 required left        [ Submit Kaizen ]`
  - Meter: a 4px track in `edgeSoft`, the fill in `ink`, width by **`scaleX` with
    `transformOrigin: 'left'`** (house rule from `plans/001-meter-scalex.md`; never animate
    width). Phase 1–3: no animation, it just updates. Phase 4 adds the 143ms transition (M5).
  - "N of 12" counts steps whose state is `done` (optional steps count when filled).
    "N required left" counts required steps not done; when 0, show "Ready to submit".
  - Footer top border 2px `edge`, background `tile2`, like the tab bar, so it reads as part
    of the bar.
- Hide the footer while the keyboard is up (`Keyboard.addListener('keyboardDidShow'/'Hide')`,
  core RN). It would otherwise sit on the keyboard and cover the box being typed in. (Phase 4
  does not need `react-native-keyboard-controller` for this; do not add it.)
- Also hide it while the camera is open (the form already swaps to `CameraCapture`).
- Content `paddingBottom` grows by the footer height so the last step is not hidden.
- **Accept:** on a 360×800 AVD the Submit is always visible when the keyboard is down; the
  count changes as steps complete; at font scale 1.3 nothing clips (wrap the text, keep the
  button ≥ 48dp).

### 2.3 Drafts resume, and can be discarded (#5)
- **Resume (B only, OTA):** `new.tsx`: query `listLocalKaizens` for `DRAFT`s. If ≥ 1 and the
  form has no id yet, render a chooser above the form instead of the blank form:
  `Card` "You have a draft from 8 Oct: *{theme or machine or 'untitled'}*" with
  `[Continue draft]` (primary → `router.push('/kaizen/edit/[id]')`) and `[Start a new one]`
  (secondary → shows the blank form). More than one draft: list them (KaizenCard) with
  "Start a new one" below.
- **Discard (owner decision #21; needs X.2 merged first):** drafts are **upserted to the
  server** (`createLocalKaizen` enqueues `kaizen upsert`), so discarding is a synced action:
  - `lib/db/migrations.ts`: local `discarded_at` on `local_kaizens`.
  - `kaizen.repository.ts`: `discardLocalKaizen(database, kaizenId)`. DRAFT only (reuse
    `editableKaizen`'s guard, then check status). Set `discardedAt`; drop that Kaizen's
    still-unsent outbox and media-queue items **except** an `upsert` the server may already
    hold (mirror `removeLocalKaizenPhoto`'s `neverSent` logic: a draft the server never heard
    of needs no `discard` op at all); enqueue `kaizen discard` otherwise. Unit tests beside
    `kaizen.repository.test.ts`: never-sent draft → no op queued; sent draft → one op;
    a SUBMITTED Kaizen → refused.
  - Every local list and count (`listLocalKaizens`, `localKaizenCounts`, `listResumableAudits`
    is 5S, leave it) excludes discarded rows. `refreshLocalKaizens` (the pull) must not bring a
    discarded draft back.
  - UI: in the form, for a `DRAFT` only, a `ConfirmAction` at the very bottom of the scroll (not
    in the sticky footer, which holds Submit; destructive actions stay away from the primary):
    title "Delete draft", question "Delete this draft? It is removed from this phone and from
    your Drafts. This cannot be undone.", confirm "Delete draft". On success:
    `router.navigate('/kaizen/overview')`. No slip (nothing to act on). The draft simply is
    not there.
  - The "Continue draft" chooser on the New tab gets the same delete as a compact
    `ConfirmAction` on each draft row, so a leader can clear old drafts without opening each.
- **Accept:** with a draft, New Kaizen offers to continue it; Start new gives a blank form;
  Delete draft removes it from Overview, History and the picker count, survives a pull-to-refresh,
  and the server stops listing it.

### 2.6 Before and after photos are required (owner decision #20; needs X.1 merged first)
- `kaizen-form.tsx`:
  - `stepState('before' | 'after')`: `done` when the photo exists, otherwise **`required`**.
  - Submit's check: `missingKaizenItems(sheet, { before: !!current?.before, after: !!current?.after })`
    from `@audit5s/domain`, replacing the bare `missingKaizenFields` call. Map `beforePhoto` →
    step `before`, `afterPhoto` → step `after` in the step lookup.
  - In 2.1's required-fields wiring, anchor the photo buttons row as `beforePhoto` /
    `afterPhoto` so a refused submit scrolls to the missing photo step (there is no text box to
    focus, so the anchor is enough).
  - Footer count (2.2) and `formProgress` include the two photo steps as required.
  - Hint under each photo step: "Required. A photo from the gallery is fine if the problem was
    already fixed." for Before; "Required. The same view as the before photo, after the fix."
    for After.
- `kaizen.repository.ts` `submitLocalKaizen`: refuse with the same `missingKaizenItems` list
  (it already refuses missing fields), so nothing can queue a photo-less submit.
- **Hold the submit until the photos are up** (the sync engine): a `kaizen_submission` item
  whose Kaizen has a BEFORE or AFTER photo not yet committed on the server
  (`localKaizenPhotos.uploadedAt` / commit not confirmed; read the engine's photo states to pick
  the right one) is **deferred**, not sent. The engine already counts `deferred`. It goes
  on the cycle after the commit lands. Test it in the engine's tests: a failed PUT ⇒ the
  submit stays queued, it is not dead-lettered.
- Card and detail: no change. The "Before · none" hatch stays for old Kaizens that predate this.
- Existing drafts on phones: after this ships, they need both photos before they can be
  submitted. That is the decision, and no migration is needed.
- **Accept:** Submit with no photos → refused, the Before step opens, and the banner names
  both photos; with both photos in airplane mode → submits locally, shows "Not sent yet";
  airplane off → photos upload first, then the submit, and the Kaizen gets its number. Force a
  photo PUT failure (stop MinIO in the local stack) → the submit waits, nothing dead-letters;
  restart MinIO → everything goes.

### 2.4 Save while typing (#4, only if Phase 0.1 confirmed it)
- In `textField`, keep `onBlur={() => commitText(field)}` and add a debounced commit on change:
  a per-field `setTimeout` of **800 ms** after the last keystroke, cleared on the next keystroke
  and on blur.
- Flush on leave: an `AppState` `change` listener (`background`/`inactive`) and the form's
  unmount cleanup both call a `flushAll()` that commits every field whose parsed value differs
  from the saved one (`pendingTextFields()` already computes exactly that set).
- **Do not break the draft rule:** an empty, untouched form must still create nothing.
  `commitText` already returns early when the value equals the saved one; keep the debounce
  going through `commitText`, never straight to `save`.
- Validation errors (date, saving) still show on blur only, not while typing.
- **Accept:** rerun 0.1. Nothing is lost; opening and leaving New still creates no draft
  (`localKaizenCounts` unchanged).

### 2.5 Step header press + Next scroll (S5, S10)
- Step header `Pressable` style: `({ pressed }) => [styles.stepHead, pressed && { backgroundColor: theme.color.tile2 }]`.
  Colour only (step headers are tapped tens of times per Kaizen: Emil's "near-imperceptible" tier).
- Next: replace `setTimeout(…, 60)` + the stale `stepY[index]` with a scroll that runs after
  the newly opened step lays out: in that step's `onLayout`, if it is the one just opened by
  Next, `scrollTo({ y: layout.y - theme.space.sm, animated: true })`. Delete `stepY`.
- **Accept:** Next on step 03 → step 04's header sits at the top of the viewport, no lurch.

---

## Phase 3 — detail, Coordinator, polish (JS only, OTA)

### 3.1 Photos you can open (S4, OTA half)
- New `components/kaizen-photo-viewer.tsx`, modelled on `PhotoPreview` in
  `components/evidence-photos.tsx` (RN `Modal`, safe-area insets, a 48dp Close in the thumb
  zone at the bottom): full-screen `Image` `resizeMode="contain"` on `board`, label tape
  "BEFORE"/"AFTER", and a two-tab switch (Before | After) using `Segmented`, so the reviewer
  compares without closing.
- Wire it: detail `PhotoBox` → `Pressable` (`accessibilityRole="imagebutton"`,
  label "Open before photo"); form `photoStep` preview → same viewer; card stays as is (the card
  tap opens the Kaizen).
- Phase 4 adds pinch-zoom and swipe-down-to-close inside this same component.
- **Accept:** tap Before on the detail → full screen; switch to After; Close; Android Back closes.

### 3.2 Review that confirms and moves on (#15, S6)
- `[kaizenId].tsx` review card:
  - Approve = `primary` when selected, as now; **Reject uses `variant="danger"`** (outline), so
    the final, destructive choice never looks like Approve.
  - Confirm label = the action name (1.7).
  - `onSuccess`: instead of `router.back()`, `router.replace` to the **next** `SUBMITTED` Kaizen
    in the queue (from the `['kaizens','SUBMITTED']` cache, excluding this id) with a param
    `reviewed={kaizenNo}:{decision}`; if the queue is empty, `router.back()` with the same param.
    The destination shows one slip: "Approved KZ-0012. 3 more waiting." / "Sent back KZ-0012
    to {author}." Strings in EN/HI/MR.
- **Accept:** approve with 2 waiting → the next one opens with the slip; with 0 → back on
  Overview with the slip.

### 3.3 Module hint (#18; owner's Profile ruling stays)
- `components/sync-status-bar.tsx`: none. Keep the bar as ruled.
- On the **module picker**, under the two tiles, one `Muted` line:
  "Switch any time from your initials, top left." (`t.switchHint`). This puts the hint where
  the person makes the choice. No new control.

### 3.4 Filter that fits (#16, only if Phase 0.2 confirmed it)
- `kaizens.tsx`: wrap `Segmented` in a horizontal `ScrollView`
  (`showsHorizontalScrollIndicator={false}`) and give each segment `minWidth: 88`. Or, if the
  owner prefers, drop "All" (Pending is the default; All is rarely the job). Default: scroll.

### 3.5 Tab icons and chart timing (#19, S11)
- Tab icons: keep text glyphs, but render them in **DM Mono** at a fixed `width: 24`,
  `textAlign: 'center'` so they align the same on every device font. (A real icon set is a new
  dependency: not worth an APK.) 5S's `(tabs)/_layout.tsx` uses the same `icon(glyph)`
  helper, so change **both** bars in the same way, or the two modules' bars drift apart.
- `kaizen-charts.tsx` `AnimatedWidth`: duration 220 → `theme.motion` (143, see 4.2).

---

## Phase 4 — native: motion, haptics, date picker (one PR, new APK)

**Owner-approved 2026-10-10.** One PR, after Phases 1–3 have merged into `main`.

### 4.1 Packages and the version bump
```sh
cd apps/field-mobile
npx expo install react-native-reanimated react-native-worklets react-native-gesture-handler expo-haptics @react-native-community/datetimepicker
```
- `npx expo install` picks the SDK 57 versions. Do not hand-edit versions.
- RN 0.86 runs the New Architecture (Reanimated 4 needs it). Confirm `newArchEnabled` is not
  switched off in `app.config.ts`.
- `babel-preset-expo` wires the worklets plugin. Do not add a `babel.config.js` entry unless
  a build fails without it.
- Wrap the root (`src/app/_layout.tsx` `RootLayout` return) in `GestureHandlerRootView`
  (`style={{ flex: 1 }}`).
- **`app.config.ts` `version: '0.1.0'` → `'0.2.0'`, in the same commit.** Leave
  `native-baseline.txt` alone (the owner updates it after building).
- Run `node apps/field-mobile/scripts/native-changed.mjs` and paste its output into the PR:
  it **must** report a native change. The PR description must state, in bold, "This PR needs
  a new APK. Merge to main only on the day the APK is handed out."
- Build a **release** dev APK locally (memory: local-dev-environment, "building a signed APK
  locally") for feel checks. Do not run `eas build` or `eas update`.

### 4.2 Motion tokens (port, don't retype)
- `lib/theme.ts` `shared`: add `motion: 143` and `press: 3` (they mirror `--motion` / `--press`
  in `gemba-tokens.css`; GEMBA §8 is the porting rule; add a comment saying so).
- New `lib/motion.ts` (the only file that imports Reanimated's easing):
  ```ts
  import { Easing, ReduceMotion } from 'react-native-reanimated';
  export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
  export const timing = { duration: 143, easing: EASE_OUT, reduceMotion: ReduceMotion.System } as const;
  ```
  Keep it this small. No animation framework of our own.

### 4.3 The motion layer: gated, each with a named purpose

| ID | Where | Frequency → decision | Purpose | Implementation | Reduced motion |
|---|---|---|---|---|---|
| M1 | `Magnet` / `Button` / `Card` / `Slip` press (shared `ui.tsx`, **also 5S**) | Tens/day → ≤150ms | Feedback | Reanimated CSS transition on `transform` + `shadowOpacity`: 143ms ease-out into the 3px sink; release the same. Pressed style stays the source of truth; only the transition is added | Sink distance 0, shadow collapse kept (house rule from plan 002) |
| M2 | Form step body open | Tens per Kaizen → barely | Prevent a jarring change | `entering={FadeIn.duration(143)}` on the step body only. **No height animation, no `LinearTransition` on the list.** It fights the keyboard and TextInputs on Android | Opacity kept |
| M3 | Submit success slip (Overview) and review slip | Occasional → standard | State indication | `entering={FadeInDown.duration(143).easing(EASE_OUT)}` from 6px, not from the edge | Opacity only |
| M4 | The just-submitted card on Overview | Occasional | Spatial: "here it is" | Card gets `accentSoft` background, then a 1.6s ease-out transition back to `tile` (the admin-web arrival highlight, `plans/005-arrival-transition.md`, ported) | Keep the colour change (it is the meaning), no movement anyway |
| M5 | Footer progress meter | Per step | State indication | `scaleX` transition 143ms ease-out | Instant |
| M6 | Photo viewer (`kaizen-photo-viewer.tsx`) | Occasional | Direct manipulation | `Gesture.Pinch` (1×–4×, rubber-band past the ends) + `Gesture.Pan` when zoomed + double-tap toggles 1×/2.5× around the tap point; `Gesture.Pan` down at 1× dismisses on **distance > 120 or velocity > 800**, background opacity follows the drag; springs `{ duration: 400, dampingRatio: 1 }` to settle, `{ duration: 300, dampingRatio: 0.8, velocity }` to snap back. Shared values only; no `setState` in `onUpdate`; `scheduleOnRN` only in `onEnd` | No spring overshoot (`dampingRatio: 1`); dismiss is a fade |
| M7 | Haptics (below) | — | Feedback | — | Haptics follow the system setting |
| — | Tab switches, screen pushes, the module picker | 100+/day or navigation | — | **None.** Native stack defaults; tabs never slide | — |

Rejected on purpose (record in the PR): a staggered list entrance on Overview (seen dozens of
times a day; decoration); a "celebration" on approval (the leader isn't in the app when it
happens); animating the step card height (layout thread, keyboard conflicts).

### 4.4 Haptics: five moments, each paired with a visual

| Moment | Call | Visual it pairs with |
|---|---|---|
| Submit accepted | `notificationAsync(Success)` | M3 slip |
| Submit refused (missing boxes) | `notificationAsync(Error)` | 2.1 banner + red box |
| Photo captured (camera shutter, Kaizen only) | `impactAsync(Light)` | Preview appears |
| Destructive confirm fired (remove photo, discard draft, Reject) | `impactAsync(Medium)` | `ConfirmAction` / slip |
| Review decision confirmed | `notificationAsync(Success)` | M3 slip |

Never on checkboxes, segments, scroll, tab taps or Next. Fire in the same handler as the visual
change, not after the animation ends.

### 4.5 Native date picker (#10)
- `implementedOn`: replace the text `Field` with a `Pressable` field (same `Field` look: label,
  box, value) showing the date as `formatDate` (e.g. 9 Oct 2026), opening
  `DateTimePickerAndroid.open({ value, mode: 'date', maximumDate: new Date(), onChange })`.
  On set, store `YYYY-MM-DD` via `istDateKey`. Remove `badDate` handling for this field (the picker
  cannot produce a bad date). Keep the stored format unchanged.
- **Accept:** cannot pick a future date; the saved value is ISO; the detail and PDF show it as
  before.

---

## Phase 5 — verification and hand-off

1. **Unit tests** (`pnpm --filter field-mobile test`): add the smallest checks for the new
   logic only:
   - Overview grouping: `needsFix` excludes `REJECTED`; the 30-day counts use `submittedAt`.
     Extract a pure `groupLeaderKaizens(all, now)` next to the screen if that makes it
     testable, and test it.
   - Footer counts: a pure `formProgress(sheet, photos)` → `{ done, requiredLeft }`, tested
     against `missingKaizenFields`.
   - Debounced save: a fake-timer test that an untouched form creates no draft.
2. **Maestro** `.maestro/kaizen.yaml`: update for the new copy ("Waiting", "Needs your fix",
   "Kaizen submitted"), the footer Submit (it is no longer at the end of the scroll), the
   prefilled names, the Remove-photo confirm, and the review → next-item flow. Add one
   assertion that the submitted slip shows. Run it end to end against the local stack.
3. **Full CI gate from the repo root** (lint, typecheck, test, build) per the
   `verify-before-committing` memory.
4. **After screenshots**, the same set as 0.3, light and dark, EN and MR, into
   `output/kaizen-ux-2026-10-10/after/`. Put before/after pairs in the PR.
5. **GEMBA acceptance checklist** (`GEMBA-BOARD.md` "Acceptance checklist") on every touched
   screen: no hex literals, no radius, no blurred shadow, one slip per view, status by shape,
   48dp targets, both themes.
6. **5S regression** (M1 touches shared `ui.tsx`): run the existing 5S Maestro flows and one
   manual audit on the release APK.
7. **Feel check (Phase 4)** on the slowest Android AVD/phone available, **release build**:
   press a button and slide off it (press must cancel cleanly); pinch past 4× and let go
   (rubber-band, settle without bounce); flick the photo down fast from 1× (dismiss on velocity
   alone); turn on Remove animations in Android settings and repeat everything (opacity only, no travel).

### PR shape and order
1. **PR A1 (X.1 + X.2)**, `kaizen/krxna` → `main` (#102). Shared `missingKaizenItems`, discard
   endpoint, migration, contracts. Merges **first**.
2. **PR B1 (Phases 1–3, incl. 2.3 Delete draft and 2.6 required photos)**, `kaizen/krxna` →
   `main`, after A1 has merged. OTA-safe: `native-changed.mjs` reports **no** native change.
3. **Release N** is the owner's go to merge B1 into `main`. A1 is already deployed by then, so
   the discard endpoint exists before any phone calls it.
4. **PR A2 (X.3, server enforces photos)**, `kaizen/krxna` → `main`. Opened any time, **merged
   only once Release N has been on phones for a week.** Ships as Release N+1.
5. **PR B2 (Phase 4, native)**, `kaizen/krxna` → `main`, after B1. Version 0.2.0; bold
   release warning; merged only on the day the APK is handed out. It can travel with
   Release N+1 or later.

## Definition of done
- [ ] Every finding row above is fixed, or marked "no change needed" with the Phase 0 evidence,
      or deferred by the owner in writing.
- [ ] Both PRs pass the full CI gate; Maestro `kaizen.yaml` passes end to end.
- [ ] Before/after screenshots, light/dark, EN/MR, in the PR.
- [ ] No string without HI and MR.
- [ ] PR B1 has no native change; PR B2 bumps `version` and says it needs an APK.
- [ ] No photo-less submission can reach the server from a new phone (engine test), and the
      server does not enforce photos until Release N+1 (PR A2 held).
- [ ] `DECISIONS.md` records owner decisions #20 and #21.
- [ ] Nothing committed to or merged into `main`.
