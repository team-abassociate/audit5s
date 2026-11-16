# 006 — Motion in admin-web: `lib/motion.ts` and the four places it moves

> **Branch rule (owner, 2026-10-31):** one team, one flow. Cut a short branch from
> `origin/main` for each change and open its PR straight into `main`. Merging into `main` is a
> release to the production VPS: green CI first, and only with the owner's go.

Written 2026-11-09 against `origin/main` `2bebd36`. Design rules: [`docs/design/LEDGER.md`](../docs/design/LEDGER.md).
Motion reference: [`docs/reference/motion.md`](../docs/reference/motion.md).

## Why, in one paragraph

admin-web already animates well in CSS: dialogs, menus, the side panel, slips, row expand, the
PDF panel, meters and the arrival tint (plans 001–005). CSS cannot do two things: animate an
element **after React has removed it**, and slide the **siblings into the gap** it leaves. Those
two, and nothing else, are what Motion is used for. Every other Motion feature was reviewed on
2026-11-09 and declined (table at the end), so this plan adds no springs, staggers, scroll
effects, drag, hover or tap animations.

## What changes for the user

| # | Screen | Today | After |
|---|---|---|---|
| 1 | **Schedule audit** dialog: the chosen auditors and suggested Zones (the × chips) | Press × and the chip vanishes. The chips after it jump left, and "lead" jumps to the next person. | The chip fades out while the chips after it slide into its place. "lead" moves with its new owner. |
| 2 | **New Unit** dialog, Next and Back | The step's fields swap with no movement. | Next brings the new step in from the right and Back from the left, 12px plus a fade. The old step fades out at the same time, toward the opposite side. |
| 3 | **New Unit** dialog, Zones step, Remove | The removed row vanishes and the rows below snap up. | The rows below slide up into the gap. |
| 4 | Every **segmented control** (Kaizen period and view, Cross-audit board, Zone run filter, corrective-action answer) | The maroon fill jumps to the new choice. | The maroon fill glides to the new choice. |

Two candidates were dropped after reading the code:

- **Notifications, Unread only.** A row leaves that list only once it is marked read, which
  happens when its link is clicked. The click navigates away, so nobody sees the row go.
  "Mark all read" empties the list, and the empty state replaces it.
- **Side panel exit through `AnimatePresence`.** The CSS exit works and can be interrupted.
  Rewriting it would move focus-return timing in three callers (Audits, Corrective actions,
  Kaizen) to save about ten lines. That isn't worth the risk. Its `PANEL_EXIT_MS = 160`
  duplicate stays as it is.

## Rule 1 holds: no timing literals in TypeScript

LEDGER rule 1: *no duration outside the token files*. `lib/motion.ts` contains **no** durations
or curves. It reads `--dur-micro`, `--dur-short` and `--ease-out` from `ledger-tokens.css` at
runtime, the way `lib/tokens.ts` `useToken()` already reads colours for Recharts. If a token
changes in the token file, CSS and Motion both follow it.

A missing token (jsdom in tests, or a token renamed by mistake) yields duration `0`. Nothing
breaks; the change is just instant.

## Phase 0 — Branch and dependency

1. Create a worktree off `origin/main`: `git worktree add .claude/worktrees/motion -b feat/admin-motion origin/main`.
   Other agents share the main checkout, so commit only these files, from the worktree.
2. In the worktree, `pnpm --filter @audit5s/admin-web add motion@14.10.1`. The `motion` line
   in the main checkout's `package.json`/`pnpm-lock.yaml` is uncommitted. Add it again here; do
   not copy those files across.
3. Record the baseline: `pnpm --filter @audit5s/admin-web build` and note the gzip size of each
   chunk from Vite's output. Phase 1 is compared against it.

## Phase 1 — `lib/motion.ts`, its test, and the root

### `apps/admin-web/src/lib/motion.ts`

```ts
import type { Transition } from 'motion/react';

/** "120ms" → 0.12, "0.2s" → 0.2; anything else → 0 (instant). */
export function seconds(value: string): number {
  const match = /^([\d.]+)(ms|s)$/.exec(value.trim());
  if (!match) return 0;
  const n = Number(match[1]);
  return match[2] === 'ms' ? n / 1000 : n;
}

/** "cubic-bezier(.23,1,.32,1)" → [0.23, 1, 0.32, 1]; anything else → undefined. */
export function bezier(value: string): [number, number, number, number] | undefined {
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(value.trim());
  const parts = match?.[1].split(',').map(Number);
  return parts?.length === 4 && parts.every(Number.isFinite) ? (parts as [number, number, number, number]) : undefined;
}

let cached: { micro: Transition; short: Transition } | undefined;

/**
 * The two Ledger timings (rule 9) as Motion transitions, read from ledger-tokens.css.
 * `micro`: exits and the segmented-control pill. `short`: entrances and layout slides.
 * Durations do not change with the theme, so they are read once.
 */
export function ledgerMotion(): { micro: Transition; short: Transition } {
  if (cached) return cached;
  const style = getComputedStyle(document.documentElement);
  const ease = bezier(style.getPropertyValue('--ease-out')) ?? 'easeOut';
  const make = (token: string): Transition => ({ duration: seconds(style.getPropertyValue(token)), ease });
  cached = { micro: make('--dur-micro'), short: make('--dur-short') };
  return cached;
}
```

`'easeOut'` is Motion's named curve, used only if `--ease-out` cannot be read. It is not a
Ledger value.

### `apps/admin-web/src/lib/motion-features.ts`

```ts
// Loaded after first paint by <LazyMotion>: layout animations need domMax.
export { domMax as default } from 'motion/react';
```

### `apps/admin-web/src/lib/motion.test.ts`

This is the one check left behind. The parsers are the only logic, so they are what it tests:

- `seconds('120ms') === 0.12`, `seconds('0.22s') === 0.22`, `seconds('') === 0`, `seconds('fast') === 0`.
- `bezier('cubic-bezier(.23,1,.32,1)')` → `[0.23, 1, 0.32, 1]`, `bezier('ease-out') === undefined`,
  `bezier('cubic-bezier(1,2)') === undefined`.
- It reads `docs/design/ledger-tokens.css` from disk and asserts that `--dur-micro`, `--dur-short`
  and `--ease-out` are still there and still parse. Renaming a token then fails CI instead of
  silently making Motion instant.

### Root, `apps/admin-web/src/main.tsx` (around line 443)

```tsx
<StrictMode>
  <MotionConfig reducedMotion="user">
    <LazyMotion features={() => import('@/lib/motion-features').then((r) => r.default)} strict>
      <QueryClientProvider client={queryClient}>…</QueryClientProvider>
    </LazyMotion>
  </MotionConfig>
</StrictMode>
```

- `reducedMotion="user"`: when the OS asks for reduced motion, Motion drops transform and layout
  animation and keeps opacity. That is LEDGER rule 9 (feedback stays, movement goes), with no
  per-component code.
- `strict`: any `motion.div` throws. Components use `m.*` from `motion/react-m`, so the full
  43 kB component can't get into the bundle.
- The public corrective-action route renders under the same root, so it gets the same setup.

### Usage convention (applies to every phase)

```tsx
import * as m from 'motion/react-m';
import { AnimatePresence, LayoutGroup } from 'motion/react';
import { ledgerMotion } from '@/lib/motion';
```

Never put a CSS `transition` on a property Motion animates on the same element; the two fight.

**Phase 1 check:** `pnpm --filter @audit5s/admin-web build`. The main chunk should grow by
`LazyMotion` + `m` only. `domMax` should be in its own async chunk. If `domMax` lands in the
main chunk, fix the split before Phase 2.

## Phase 2 — Schedule-audit chips (`features/audits/AuditsPage.tsx:845` and `:891`)

| Element | Role | Starts | Duration | Motion | Relationship |
|---|---|---|---|---|---|
| Removed chip | Lead | 0 | `micro` (120ms) | fade, scale to 0.97 | — |
| Chips after it | Support | 0 | `short` (220ms) | slide into the gap | Together (`popLayout`) |
| "lead" tag | — | 0 | — | rides inside its chip | Carried by its parent |

Both lists get the same treatment:

```tsx
<ul className="gb-picked" aria-label="Chosen auditors">
  <AnimatePresence mode="popLayout" initial={false}>
    {picked.map((id, index) => (
      <m.li
        key={id}
        layout="position"
        transition={ledgerMotion().short}
        exit={{ opacity: 0, scale: 0.97, transition: ledgerMotion().micro }}
      >
        …unchanged…
      </m.li>
    ))}
  </AnimatePresence>
</ul>
```

- `styles.css` `.gb-picked`: add `position: relative`. `popLayout` positions the leaving chip
  absolutely against it.
- **A chip being added has no entrance.** Picking from the combobox is a keyboard action, so the
  chip just appears. There is no `initial` on `m.li`.
- `layout="position"`, not `layout`. The chips only move; the one that gains "lead" changes
  width, and animating that size would stretch its border.
- **Known edge:** removing the *last* chip unmounts the whole list (`picked.length > 0 &&`), so
  that chip vanishes at once. Keep it that way: at the same moment the field's placeholder
  changes, and an empty list with a margin would leave a gap.
- **Risk:** the dialog body may scroll. If, after scrolling it, a removal makes the chips
  jump instead of slide, the scroll offset isn't being measured. In that case drop `layout`
  and keep only the exit fade. Do not wrap the native `<dialog>`.

## Phase 3 — New Unit steps (`features/units/NewUnitDialog.tsx:351–417`)

| Element | Role | Starts | Duration | Motion | Relationship |
|---|---|---|---|---|---|
| Old step's fields | Support | 0 | `micro` | fade, 12px toward the side it leaves | Crossfade (`popLayout`) |
| New step's fields | Lead | 0 | `short` | fade, from 12px on the side it enters | Crossfade |
| Step list (`ol`), "Step n of 5" heading, buttons | Static | — | — | — | They stay put, and the heading takes focus, as it does today |

- Direction: a `useRef<1 | -1>`. `next()` sets `1`. The step-list jump (`setStep(target)`, line
  283) sets `Math.sign(target - step)`. It is passed as `custom` to **both** `AnimatePresence`
  and the step. The leaving step reads it from `AnimatePresence` because its own props are frozen.
- Wrap only the step blocks:

```tsx
<div className="gb-steps">
  <AnimatePresence mode="popLayout" initial={false} custom={direction.current}>
    <Step key={step} direction={direction.current}>
      {step === 0 && (…)}
      …
    </Step>
  </AnimatePresence>
</div>
```

  `Step` is a local `m.div` with variants `enter: (d) => ({ opacity: 0, x: 12 * d })`,
  `center: { opacity: 1, x: 0, transition: short }`, `exit: (d) => ({ opacity: 0, x: -12 * d,
  transition: micro })`. It sets `inert` from `useIsPresent()`, so the leaving step's fields
  can't be clicked or tabbed into during its 120ms.
- `styles.css` `.gb-steps { position: relative; overflow: clip; overflow-clip-margin: 4px; }`.
  The clip keeps a taller leaving step from spilling below the dialog. The 4px margin keeps the
  2px focus ring at its 2px offset visible (LEDGER rule 8).
- The dialog's height changes at once to fit the new step. That is deliberate: animating height
  would break rule 9, and the dialog is anchored at the top, so only its bottom edge moves.
- Validation errors and `showErrors` are unchanged. A Next that fails validation doesn't change
  `step`, so nothing animates.

## Phase 4 — New Unit Zone rows (`NewUnitDialog.tsx` `ZonesTable`, line 656)

| Element | Role | Starts | Duration | Motion | Relationship |
|---|---|---|---|---|---|
| Removed row | — | — | — | gone at once | — |
| Rows below it | Lead | 0 | `short` | slide up into the gap | — |
| Added row (Enter or "Add Zone") | Static | — | — | appears | Keyboard action, focus moves to it |

- `<tr>` → `<m.tr layout="position" layoutDependency={zones.length} transition={ledgerMotion().short}>`.
  No `AnimatePresence`, because table rows can't be taken out of the layout the way
  `popLayout` needs. The removed row goes at once and the rows below move.
- `layoutDependency={zones.length}` matters: every keystroke in a Zone name re-renders the
  table, and without it Motion would measure every row on every key.

## Phase 5 — Segmented pill (`components/ui.tsx:279`)

| Element | Role | Starts | Duration | Motion | Relationship |
|---|---|---|---|---|---|
| Maroon pill | Lead | 0 | `micro` | slides and resizes to the new option | — |
| Old and new labels | Support | 0 | `micro` | colour change (CSS) | Together with the pill |
| Content the control filters | Static | — | — | — | Content changes at once, the way tab content does |

```tsx
const group = useId();
<LayoutGroup id={group}>
  <div className="gb-seg" role="group" aria-label={label}>
    {options.map((option) => {
      const on = option.value === value;
      return (
        <button key={option.value} type="button" aria-pressed={on} onClick={() => onChange(option.value)}>
          {on && <m.span layoutId="pill" className="gb-seg-pill" transition={ledgerMotion().micro} style={{ borderRadius: radius }} />}
          <span className="gb-seg-label">{option.label}</span>
        </button>
      );
    })}
  </div>
</LayoutGroup>
```

- **`LayoutGroup id={useId()}`** gives each control its own pill. Kaizen shows two segmented
  controls on one screen, and an unscoped `layoutId` would fly the pill from one to the other.
- **The radius is set through `style`**, so Motion corrects it while the pill stretches between
  options of different widths. `radius` comes from `useToken()('--radius-chip')`. Today the CSS
  uses a literal `7px`; this switches to the 6px chip token, which also removes a rule 1 violation.
- `styles.css`:
  - `.gb-seg button`: `position: relative`. Change `transition` to
    `background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out)`.
    Without the colour transition the new label turns white before the pill reaches it, and white
    on `--surface` is unreadable for 120ms.
  - `.gb-seg button[aria-pressed='true']`: drop `background`, keep `color: var(--on-primary)`.
  - New `.gb-seg-pill { position: absolute; inset: 0; background: var(--primary); }` and
    `.gb-seg-label { position: relative; }`.
- `ZoneRun.tsx:247` (the hand-built section tab list) **does not get the pill**. It is a tab
  strip the auditor uses dozens of times per Zone, and tabs don't slide.
- Reduced motion: `MotionConfig` turns the layout slide off. The pill jumps and the colour
  changes in 1ms (the token file's global rule).

## Phase 6 — Docs

- `docs/design/LEDGER.md` rule 9: add one sentence. *"Motion (`motion/react`) is used only for
  exits and layout slides; it takes its timings from these tokens through
  `apps/admin-web/src/lib/motion.ts`."*
- `apps/admin-web/AGENTS.md`, stack line: add "Motion (exits and layout only, through `lib/motion.ts`)".
- `DECISIONS.md`: **R-85 — Motion in admin-web, for exits and layout only.** Owner approved
  2026-11-09. Record what it is used for, what was declined and why (the table below), that
  timings are read from the tokens, and that field-mobile keeps Reanimated.
- `plans/README.md`: add a row for 006.

## Verification

1. **CI gate, from the repo root in the worktree:** `pnpm lint && pnpm -r build && pnpm -r typecheck && pnpm -r test`.
2. **Bundle:** compare the chunk sizes with the Phase 0 baseline, write the numbers in the PR,
   and confirm `domMax` loads asynchronously.
3. **In the running app** (local dev, both themes, plus the OS reduced-motion setting), recorded
   and stepped through frame by frame:
   - Remove the middle of three chips. The gap closes *while* the chip fades, with no pause between.
   - Remove the lead chip. "lead" moves to the next chip and nothing flashes.
   - New Unit: press Next twice quickly. Only one step is on screen at the end, and the heading has focus.
   - New Unit: press Back. The step comes in from the left.
   - Zones: type in a name (no movement), then Remove the second of four rows (the rows below slide).
   - Segmented control: click from one end to the other. The new label is never white on a light background.
   - Kaizen screen with two segmented controls: each pill stays in its own control.
   - Reduced motion on: everything changes with no sliding, and the chip still fades.
4. **LEDGER "Done means":** no new literal, both themes, focus ring visible during and after
   each animation, no horizontal scroll at 400px.
5. **The 50th use:** if any of the four gets in the way after a day of use, cut it.

## Delivery

One PR, `feat(admin-web): Motion for exits and layout slides`, phases 1–6 as separate commits so
any one can be reverted on its own. CI green, then it waits for the owner's go, because merging
deploys to production. Rollback: revert the PR. Nothing is stored, so no data is involved.

## Motion features reviewed and declined (2026-11-09)

| Feature | Why not |
|---|---|
| Variants + stagger | Lists and tiles are opened many times a day; a cascade makes people wait every time |
| Springs | Nothing is thrown or dragged, and the CSS uses one ease-out family that Motion matches |
| `whileTap` / `whileHover` | CSS already does press and hover (plans 003, 004) |
| Drag, `Reorder` | Nothing is dragged; checklist sections are fixed and Zones are ordered by number |
| `whileInView`, `useScroll` | Figures that wait to be scrolled to are slower to read; the only scroll candidate, a shadow under the sticky title row, is plain CSS (`animation-timeline: scroll()`) |
| Motion values, `useAnimate` | No gesture or multi-step sequence to drive |
| SVG `pathLength` (dashboard score line draw-in) | The dashboard is opened all day and the line is data. Possible later as a once-per-session moment, if the owner wants it |
| `AnimateView` (view transitions) | Navigation is the most frequent action; it would also need React ≥19.3 pinned |
| Motion+ (AnimateNumber, Ticker, Carousel, Typewriter, ScrambleText, Cursor, AnimateActivity, AnimateSuspense, useCurtains) | Paid and not installed; a counting score delays reading it |
