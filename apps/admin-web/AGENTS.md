# apps/admin-web — agent brief

Read the root [`AGENTS.md`](../../AGENTS.md) first; it is not repeated here. This file covers
only what is specific to the admin web app.

- React 19 + Vite 7 SPA, **no SSR**. TanStack Router + TanStack Query. Tailwind + shadcn/ui,
  Recharts, react-hook-form + Zod, Motion (exits and layout only, through `lib/motion.ts`). Schemas are imported from `packages/contracts` — never
  redeclared here.
- Every list and detail view is scope-filtered by the server. The client never decides what a
  role may see; it renders what the API returned and shows an honest empty state when that is
  nothing.

## UI is built from the design system

[`DESIGN.md`](../../DESIGN.md) locks the system; [`docs/design/LEDGER.md`](../../docs/design/LEDGER.md)
is binding. Read it and `docs/design/ledger-tokens.css` (imported by `src/styles.css`) before
writing any component.

The rejectable violations, restated so they are unmissable:

1. **No literal colour, radius, shadow, duration or font name outside `ledger-tokens.css`.**
   Use the role (`var(--surface)`, `bg-chip`, `rounded-card`) — never the value.
2. **Shape from the scale:** 22 big cards · 18 cards · 14 panels · 10 controls · 6 chips ·
   999 pills. Cards are flat on the ground; only the outer app frame has `--shadow-frame`.
3. **Manrope only**; Noto Sans Devanagari renders Devanagari text and nothing else (R-45 c).
   Figures tabular, headline numbers 600 with −0.03 to −0.04em tracking. Sentence case,
   no uppercase tracked labels.
4. **Four score bands, four colours** (R-6b, `src/lib/bands.ts`): Outstanding ≥ 90 green,
   On Track 75–89.9 blue, Improving 60–74.9 yellow, Needs Support < 60 red. Chips are tint +
   band text (`gb-chip gb-chip--<band>`), bars solid (`--band-*`), and the band **label** is
   always shown. Red means a score band and nothing else; past-due is maroon text plus the words.
5. **Maroon `--primary`** fills the selected nav item, headline cards and the one primary button
   style; links and change figures use `--primary-ink`.
6. **An all-`NA` section renders `N/A` on a hatch and is excluded from the average**, never 0
   (`ARCHITECTURE.md` §1.5-D4). Not-started is a dashed tile and an em dash, also not 0.
7. **Both themes must work**: no attribute (the device decides), `data-theme="light"` and
   `data-theme="dark"`. The shell's theme switch cycles System → Light → Dark.
8. **Every control has an instant `:focus-visible` ring** (`--focus`, 2px, 2px offset).

shadcn/ui components ship their own radii and shadows: repoint them at the Ledger radius scale
and drop the shadows, or do not use the component. Recharts colours come from `useToken()`
reads of the tokens, never hard-coded hex.

Definition of done for a UI task is the "Done means" list in `LEDGER.md`. Run through it before
you say the work is complete.
