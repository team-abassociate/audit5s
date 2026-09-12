# apps/admin-web — agent brief

Read the root [`AGENTS.md`](../../AGENTS.md) first; it is not repeated here. This file covers
only what is specific to the admin web app.

- React 19 + Vite 7 SPA, **no SSR**. TanStack Router + TanStack Query. Tailwind + shadcn/ui,
  Recharts, react-hook-form + Zod. Schemas are imported from `packages/contracts` — never
  redeclared here.
- Every list and detail view is scope-filtered by the server. The client never decides what a
  role may see; it renders what the API returned and shows an honest empty state when that is
  nothing.

## UI is built from the design system

[`docs/design/GEMBA-BOARD.md`](../../docs/design/GEMBA-BOARD.md) is binding. Read it and
`docs/design/gemba-tokens.css` in full, and open `docs/design/reference-dashboard.html`,
before writing any component.

The rejectable violations, restated so they are unmissable:

1. **No `border-radius`.** Zero is the only value.
2. **No blurred shadows.** Elevation is `box-shadow: Npx Npx 0 var(--hard)` — 2px buttons,
   3px at rest, 5px hover/selected, 0 on press with `translate(3px,3px)`.
3. **Two families only** — Archivo (display/UI) and DM Mono (small data). Display figures are
   **Archivo 900**, `letter-spacing:-.04em`, tabular. Mono is never used for a big number.
4. **No hex literal outside `gemba-tokens.css`.**
5. **Accent (`--accent`) is interaction only** — focus and selection. Never a chart fill,
   never decoration. Score bands carry meaning: ≥80 ok, 60–79.9 warn, <60 crit, target 85.
6. **Status reads without colour** — a band, a 4px rail, an outlined chip, or the `.gb-na` hatch.
7. **One yellow slip per view**, only when a human must act.
8. **An all-`NA` section renders `N/A` on a hatch and is excluded from the average**, never 0
   (`ARCHITECTURE.md` §1.5-D4). Not-started is a dashed tile and an em dash, also not 0.
9. **All three theme states must work**: no stamp (system), `data-theme="light"`,
   `data-theme="dark"`.

shadcn/ui components ship rounded and soft-shadowed. Strip `rounded-*`, replace `shadow-*` with
the token shadow, and repoint colours at the tokens — or do not use the component. Recharts
colours come from `getComputedStyle` reads of the tokens, never hard-coded hex.

Definition of done for a UI task is the acceptance checklist in `GEMBA-BOARD.md`. Run through
it before you say the work is complete.
