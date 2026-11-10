# 007 — Every Motion feature against both apps, and the phone's two moves

> **Branch rule (owner, 2026-10-31):** one team, one flow. Cut a short branch from
> `origin/main` for each change and open its PR straight into `main`. Merging into `main` is a
> release to the production VPS, and for anything under `apps/field-mobile` an OTA update to
> every phone: green CI first, and only with the owner's go.

Written 2026-11-09, after plan 006 (PR #202). The owner asked whether anything better than what
the web and the phone animate today exists in Motion, and asked for the phone items as a separate
PR. Motion (`motion/react`) is web only. It has no React Native build, so the phone items use
Reanimated 4.5.1, which is already installed (approved 2026-10-10) and already used through
`apps/field-mobile/src/lib/motion.ts`.

## Part A — Survey

### Web (admin-web), feature by feature

| Motion feature | Where it could go | Verdict |
|---|---|---|
| `AnimatePresence` exit | Schedule-audit chips, New Unit steps | **Done in 006** |
| `layout` / `popLayout` | Chips sliding into the gap, Zone rows | **Done in 006** |
| `layoutId` shared element | Segmented-control pill | **Done in 006** |
| `AnimatePresence` exit | Slip "Dismiss" (Industries) | No. `Slip.tsx`: it leaves at once by design; a fade would still leave the page jumping up |
| `AnimatePresence` exit | New-password notice dismiss (Users, Unit Zones) | No, for the same reason. The person has copied the password and is done |
| `layout` | Zone run "Overall corrective actions" Remove | No. Rows are keyed by position, so nothing can animate out without changing the state shape; at most five rows |
| `AnimatePresence` exit | Side panel | No (006): the CSS exit works, and moving it shifts focus return on three screens |
| Variants and stagger | Lists, tiles, dashboard | No. Opened many times a day; a cascade makes people wait every time |
| Springs | Anything | No. Nothing is thrown or dragged; one ease-out family everywhere |
| `whileHover` / `whileTap` / `whileFocus` | Buttons, rows | No. CSS already does press and hover (plans 003, 004) |
| Drag, `Reorder` | Checklist sections, Zones | No. Sections are fixed; Zones are ordered by number |
| `whileInView`, `useScroll`, `useTransform` | Dashboard figures, sticky title shadow | No. Figures that wait to be scrolled to read slower; the shadow is plain CSS |
| Motion values, `useAnimate`, `animate()` | Counters, sequences | No. No gesture or multi-step sequence to drive |
| SVG `pathLength` | Dashboard score line draw-in | No. It is data, and the dashboard is opened all day. Possible later as a once-per-session moment |
| `AnimateView` / view transitions | Page navigation | No. Navigation is the most frequent action, and it needs React ≥ 19.3 pinned |
| Motion+ (`AnimateNumber`, Ticker, Typewriter, …) | Scores | No. Paid, and a counting score delays reading it |

**Web conclusion:** after 006, nothing else in admin-web is better done with Motion than with the
CSS already there.

### Phone (field-mobile)

| # | Screen | Today | Verdict |
|---|---|---|---|
| M1 | Every segmented control | The maroon fill jumps | **Build**: the same glide as web 006 phase 5 |
| M2 | Zone filter chips, tap ✕ | The chip vanishes, the rest jump left | **Build**: the same as web 006 phase 2 |
| — | Kaizen form steps | Each step fades in as it opens | No. It is an accordion, not a step swap; the no-height-animation rule (M2 note in `kaizen-form.tsx`) stands |
| — | Overall-action drafts (audit screen) | The last row vanishes | No. Keyed by position, as on web |
| — | Photo viewer | Pinch, double-tap, pull-to-close springs | Already right |

## Part B — Phone PR: `feat(field-mobile): segmented pill glides, Zone chips leave gently`

### What changes for the auditor

| # | Screen | Today | After |
|---|---|---|---|
| M1 | Every segmented control: Audits board, Review, Kaizens, People, Assign, New person, Cross audit, Kaizen charts (×3), photo viewer before/after | Tap a choice and the maroon fill jumps to it | The fill glides to it in 120ms, and the label turns white with it |
| M2 | Audits and Review tabs, Zone filter chips under the list | Tap ✕ and the chip vanishes; the chips after it jump left | The chip fades out (120ms) while the chips after it slide into its place (220ms) |

Nothing else moves. Adding a chip from the filter sheet has no entrance: the sheet closes, and
the chip is simply there.

### Phase 0 — Branch

After #202 is merged: `git worktree add .claude/worktrees/phone-motion -b feat/phone-motion origin/main`.
Commit only these files, from the worktree.

### Phase 1 — `src/lib/motion.ts`: two presets, from the existing tokens

```ts
/** A chip leaving: opacity only, so it plays under reduced motion too. */
export const chipExit = FadeOut.duration(themes.light.dur.micro).easing(EASE_OUT).reduceMotion(ReduceMotion.Never);
/** Siblings sliding into a gap. Movement, so the system setting turns it off. */
export const slideIntoGap = LinearTransition.duration(timing.duration).easing(EASE_OUT);
```

No new literals. Durations come from `themes.*.dur`, which reads the Ledger tokens.

### Phase 2 — M2, Zone filter chips (`src/components/zone-filter.tsx:143`)

- Wrap each chip's `Pressable` in `<Animated.View key={zone.id} exiting={chipExit} layout={slideIntoGap}>`.
  The key moves to the wrapper. The `chips` style (row, wrap, gap) stays on the parent.
- **The last chip:** `ZoneFilterChips` returns `null` when nothing is selected, so the last chip
  goes at once together with the row. Keep it that way, as on web: the list below moves up at
  that moment anyway.
- **Reduced motion (found on the emulator):** with `.reduceMotion(ReduceMotion.System)` on the
  layout transition, Reanimated skipped the slide but never moved the later chips either, so the
  gap stayed open. The chips pass `layout={reduced ? undefined : slideIntoGap}` instead. With
  Remove animations on, the leaving chip also vanished at once rather than fading, despite
  `ReduceMotion.Never`. That is today's behaviour, so it stays.
- The press style (`chipPressed`, scale 0.97) stays on the `Pressable`. The exit runs on the
  wrapper, so the two never fight over one view.

### Phase 3 — M1, segmented pill (`src/components/ui.tsx:961`)

- Each segment reports its frame with `onLayout` into state, keyed by option value.
- One `Animated.View` pill, absolutely positioned inside the strip, behind the labels
  (`pointerEvents="none"`, `backgroundColor: theme.color.primary`, `borderRadius: theme.radius.control`).
  `segmentSelected`'s background is gone; `segmentTextSelected` stays.
- The pill takes the chosen frame (`translateX` = its `x`, plus its `width`) through a
  Reanimated CSS transition over `dur.micro`, ease-out. CSS transitions do not read the system
  setting, so the duration is 0 under `useReducedMotion()`.
- **Width (built):** the `scrolls` strip has segments of different widths, so the pill's
  `width` moves with it. A `scaleX` was rejected: with labels from 88 to ~150 wide it stretches
  the radius-10 corners visibly. The pill is a leaf with no children, so animating its width
  costs one view's layout per frame. This is the one exception to LEDGER rule 9, recorded there.
- **First layout:** the pill is not drawn until the chosen segment is measured, so it mounts
  in place and a screen never opens with the fill sliding in.
- **Label colour:** `Animated.Text` with a Reanimated CSS transition on `color`
  (`transitionProperty: 'color', ...transition`). Without it the new label turns white before
  the pill arrives. Colour keeps playing under reduced motion (plan 002).
- **Audits board (found on the emulator):** the screen drew one `SectionList` per board
  (`key={board}`, and a separate list for Assigned), so every switch remounted the header and
  the pill had nothing to glide from. It is now one list whose sections and rows follow the
  board. The other screens pass their header as an element and were unaffected.
- **Scroll strip:** the pill lives inside the strip, which scrolls, so its `x` is already in the
  right space. No scroll-into-view change.
- **Accessibility:** unchanged (`tablist`, `tab`, `selected`). The pill is decoration.

### Verification

1. **CI gate from the repo root:** `pnpm lint && pnpm -r build && pnpm -r typecheck && pnpm -r test`.
   Delete a stray `expo-env.d.ts` first (it breaks `tsc` in `ui.tsx`).
2. **No native change:** `node scripts/native-changed.mjs` against the baseline should report
   none, so this can go out over the air (`deploy.yml` refuses otherwise).
3. **Release build on the emulator** (`Pixel_10a`). A debug build is not evidence. Use both
   themes, plus Settings → Accessibility → Remove animations:
   - Audits board: tap from one end to the other; the label is never white on the light surface.
   - Kaizen charts: three controls on one screen; each pill stays in its own strip.
   - Hindi (scroll strip, "वापस …"): scroll the strip, then tap; the pill follows the
     segment, not the screen.
   - Opening any screen: the fill is already in place, with no slide-in.
   - Audits with three Zone chips: remove the middle one; it fades while the third slides in.
     Remove the last one; the row goes at once.
   - Remove animations on: nothing slides, the chips still fade, and the labels still change colour.
4. **The 50th use:** auditors tap the Audits board many times a day. If the glide gets in the way,
   cut M1 and keep M2.

### Delivery

One PR, phases 1–3 as separate commits. CI green, then the owner's go. Merging publishes an
OTA, and phones apply it on first open (#128). Rollback: revert the PR, and the revert's own OTA
restores the old behaviour on next open. Nothing is stored.
