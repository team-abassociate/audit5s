# Gemba Board — the audit5s design system

**Status:** authoritative for `apps/admin-web` and `apps/field-mobile` UI.
**Files in this folder:**

| File | What it is | How to use it |
|---|---|---|
| [`gemba-tokens.css`](./gemba-tokens.css) | Every colour, border, shadow, type role and primitive. | Copy verbatim. Never re-declare a value it already defines. |
| [`reference-dashboard.html`](./reference-dashboard.html) | A complete working screen built only from those tokens. | Open it. When a spec sentence is ambiguous, the reference wins. |
| This file | The rules, the component anatomy, and how to brief an agent. | Read §1–§3 before writing any UI. |

---

## 1. The idea in one paragraph

A 5S audit is about a plant being orderly. So the dashboard is the **magnetic whiteboard that
already hangs by the line**, rendered exactly: a dry-erase ground with a faint 28px rule,
rectangular magnets with hard ink borders and hard offset shadows, masking-tape section
markers, and a yellow slip for the one thing someone must act on. The material is physical.
The **alignment is not** — nothing tilts, nothing is hand-drawn, nothing sits off-grid. A 5S
product whose own interface is untidy is a joke, and the discipline is the point.

## 2. Non-negotiables

An agent that breaks any of these has not built this design system.

1. **No border radius.** Anywhere. `border-radius: 0` is the default and the only value.
2. **No blurred shadows.** Elevation is `box-shadow: Npx Npx 0 var(--hard)` — hard, offset down-right, zero blur. 2px for buttons, 3px at rest, 5px on hover/selected, 0 on press (with `translate(3px,3px)`).
3. **No rotation, no random offsets, no "organic" scatter.** Every object sits on the grid.
4. **Two families only:** Archivo (display + UI) and DM Mono (data). Never introduce a third.
5. **Display numerals are Archivo 900**, `letter-spacing:-.04em`, tabular. Mono is for *small* data only — table cells, timestamps, axis ticks, deltas. Getting this backwards is the most common way this system is built wrong.
6. **Colour is semantic, not decorative.** Green/amber/red mean score bands and nothing else. The teal accent (`--accent`) appears only in focus rings and selection — never as a fill, never in a chart.
7. **One yellow slip per view**, and only when a human must do something. Two slips means nothing is urgent.
8. **Status is shape + colour.** A band, a rail, an outlined chip — colour alone never carries meaning (colour-blind auditors, projector screens, sunlight on a phone).
9. **Every value is a token.** A literal hex in a component is a bug.
10. **Both themes, always.** Light = whiteboard, dark = slate board. Never invert; the dark palette is its own set of values, already in the token file.

## 3. Score semantics

There are **four** bands, not three. `packages/domain/src/rating-scale.ts` owns the scale
(R-6b) and is the only file allowed to name a colour; this table must follow it, never lead it.
This board carries three colour pairs, so the two upper bands share `--ok` and the **label** is
what keeps all four apart — which is why status must read without colour (non-negotiable 8).

| Band | Range | Token pair | Label shown |
|---|---|---|---|
| Outstanding | ≥ 90 | `--ok` / `--ok-band` | `Outstanding` |
| On Track | 75 – 89.9 | `--ok` / `--ok-band` | `On Track` |
| Improving | 60 – 74.9 | `--warn` / `--warn-band` | `Improving` |
| Needs Support | < 60 | `--crit` / `--crit-band` | `Needs Support` |
| Target line | 90 (`TARGET`) | `--crit-band`, dashed, on charts only | — |
| Not applicable | — | `.gb-na` hatch, label `N/A` | `N/A` |
| Not started | — | dashed tile, `—`, `--ink-3` | `—` |

> **This table is the one part of this document that is deliberately not the 12 Sep original.**
> The original read Good ≥ 80 / Watch / Action with a target of 85. R-6b (DECISIONS.md,
> 16 Sep) replaced that with four bands at 90 / 75 / 60 — a binding resolution that predates
> and is independent of any visual treatment, and that `rating-scale.ts`, `lib/bands.ts` and
> `board.ts` (`TARGET = 90`) already implement. Restoring the three-band table would put this
> file back in conflict with `packages/domain`. Do not "revert" it. The decimal-places rule
> below is held to the shipping code for the same reason (`score2` in `DashboardPage.tsx`).

Rules that come from the product, not from taste:

- **`N/A` is not zero.** A section where every question is `NA` renders `N/A` on a 45° hatch and is **excluded from the average**. Any UI that shows it as `0` is wrong (`ARCHITECTURE.md` §1.5-D4).
- Scores are `numeric(6,3)`. Show **one decimal** in tiles and charts, **two** in audit tables and registers, **three** in a true ledger. Never round in a way that changes a band — the band is always computed from the raw value, never re-derived from the formatted string.
- **The server owns the score.** Device-computed numbers are display-only and must be labelled as such wherever both could appear.
- Deltas use a real minus sign (`−`, U+2212) and always carry a sign, including `+0.0`.
- Every column of digits gets `font-variant-numeric: tabular-nums`.

## 4. Type

```html
<link rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..900&family=DM+Mono:wght@400;500&display=swap">
```

| Role | Family | Size | Weight | Other |
|---|---|---|---|---|
| Page / section heading | Archivo | 19px | 800 | `font-stretch:112%`, uppercase, `letter-spacing:.02em` |
| Panel heading | Archivo | 15–16px | 800 | `font-stretch:110%`, uppercase |
| Display figure (KPI, tile score, stat) | Archivo | 27–33px | **900** | `letter-spacing:-.04em`, tabular |
| Body | Archivo | 15px | 400 | `line-height:1.5` |
| Secondary / helper | Archivo | 12.5–13px | 400 | `--ink-2` |
| Field label | Archivo | 10.5px | 600 | uppercase, `letter-spacing:.13em`, `--ink-3` |
| Table + small data | DM Mono | 12–13px | 400–500 | tabular |
| Chip / badge / tape | Archivo | 10.5px | 700 | uppercase, `letter-spacing:.09–.14em` |

The expanded width axis (`font-stretch: 110–118%`) on headings is a signature of this system.
Losing it makes the page read as generic admin software.

## 5. Layout

- Base unit **14px**. Gaps are 14 / 22 / 28. Page padding 22–28px, 16px at phone width.
- Shell: fixed **216px** rail + fluid main. Rail becomes a horizontal scrolling strip below 860px.
- Topbar is sticky, 2px ink bottom border, and holds: title, scope selectors (Unit, cycle), sync pill, theme switch, secondary action, primary action, identity chip.
- Content is a single column of **sections**. Each section = heading block with a 2px ink underline, then its content 14px below.
- Tile grids: `repeat(auto-fit, minmax(178px,1fr))` for KPIs, fixed 3-up for the department board (2-up ≤860px, 1-up ≤440px).
- Detail panels are sticky at `top:86px` on desktop, static below 1180px.
- Only tables and charts may scroll horizontally, each in its own `overflow-x:auto` container.

## 6. Components

Anatomy is fixed; the data is not. Full working markup for every one of these is in
`reference-dashboard.html` — read it rather than guessing.

**Zone tile (the magnet).** `<button>` with `aria-pressed`. Anatomy top to bottom: label
(`.gb-label`, department name) → row of [figure `900`, delta mono] → meta line (leader, NC
count, NC in `--crit` when non-zero) → `.gb-band` in the score's colour. Not-started zones use
`.gb-tile--pending`, an em dash, and the striped band.

**KPI tile.** Label → figure (900) → one line of context → band. Never more than five in a row.

**Detail panel.** Header (2px ink underline) with name, code, leader, audit time → section
breakdown: 5 rows of `[label 74px | track | value 46px]` with a 0/25/50/75/100 tick row beneath
→ open findings list, each with a 4px severity rail and a mono age on the right → optional slip.

**Matrix.** Departments × S1–S5 + zone average. Cells are tinted with
`color-mix(in srgb, var(--ok-band) 20%, var(--tile))` (22% for warn/crit), mono, centred; the
average column is separated by a 2px ink border and set in Archivo 800. Rows below target carry
a `--crit-band` left rail.

**Trend chart.** Hand-authored SVG. One scale, ticks labelled with values the chart actually
reaches (40/60/80/100), dashed target rule at 90 labelled `TARGET 90`, 2.6px line, 12% area
fill, an emphasised endpoint dot with its value. All strokes and fills are tokens so it works in
both themes. Leave room in the `viewBox` for the outermost labels.

**Table.** `--tile` background, `--tile-2` sticky-feeling header with 2px ink bottom border,
1px `--edge-soft` row rules, `--tile-2` hover. First cell carries the severity rail. Status is a
`.gb-chip`.

**Dialog.** `<dialog>`, 2px ink border, 6px hard shadow, label-above-field, actions right-aligned,
secondary then primary. Never `alert()`/`confirm()`.

**Confirmation.** Actions confirm on a slip strip at the top of the page body, in the words of
what actually happened ("Report queued. The PDF worker will email the signed snapshot"), never a
generic toast and never a claim the system did not make.

## 7. Theme switch

Two states: **Light** (`data-theme="light"` — the whiteboard, and the default) and **Dark**
(`data-theme="dark"`). The OS preference is not a third state: the attribute is always
stamped, before the first paint, so the token file's `prefers-color-scheme` block is a
fallback for a document that never reaches the user, not a mode anyone can select.

```js
const modes = ["light", "dark"];
function applyTheme(m) {
  document.documentElement.setAttribute("data-theme", m);
  try { localStorage.setItem("gemba-theme", m); } catch {}
}
```

Wrap every storage read and write in try/catch and render correctly when it throws.

## 8. Porting the tokens

**Admin web (Tailwind v4, `apps/admin-web`).** Put `gemba-tokens.css` behind `@import` in
`src/styles.css` and expose the tokens to Tailwind:

```css
@theme {
  --color-board: var(--board);
  --color-tile: var(--tile);
  --color-ink: var(--ink);
  --color-ok: var(--ok-band);
  --color-warn: var(--warn-band);
  --color-crit: var(--crit-band);
  --radius-*: initial;              /* kill every rounded utility */
  --shadow-tile: 3px 3px 0 var(--hard);
  --shadow-tile-hover: 5px 5px 0 var(--hard);
}
```

shadcn/ui components ship rounded and soft-shadowed. Before using one, strip `rounded-*`,
replace `shadow-*` with `shadow-tile`, and point its colours at these tokens — or don't use it.
Recharts: pass token values via CSS variables read from `getComputedStyle`, never hard-coded hex.

**Field mobile (React Native).** React Native has no CSS variables. Export the same values once
and import them everywhere; the file below is generated from `gemba-tokens.css`, not retyped:

```ts
export const gemba = {
  light: { board:"#EEEBE1", tile:"#FCFBF7", tile2:"#F6F3EA", ink:"#1D1B16",
           ink2:"#5B5647", ink3:"#8A8372", edge:"#1D1B16", edgeSoft:"#CFC9B8",
           slip:"#E8E24B", ok:"#3E8E4B", warn:"#D79A05", crit:"#B4321F", accent:"#0B6E77" },
  dark:  { board:"#151816", tile:"#1E2220", tile2:"#191D1B", ink:"#EDEAE0",
           ink2:"#A8A899", ink3:"#7B7D71", edge:"#3C423D", edgeSoft:"#2C312D",
           slip:"#D2C92F", ok:"#49A05A", warn:"#D79A05", crit:"#D94A2E", accent:"#4FD2D8" },
} as const;
```

The hard shadow in RN: `shadowOffset:{width:3,height:3}, shadowRadius:0, shadowOpacity:1,
shadowColor:"rgba(29,27,22,0.22)"` on iOS; on Android use a second absolutely-positioned view
offset by 3px behind the tile, because `elevation` is always blurred.

---

# How to brief an agent

## The one-line brief

Put this at the top of any task that touches UI:

> Build this using the Gemba Board design system. Read `docs/design/GEMBA-BOARD.md` §1–§3 and
> `docs/design/gemba-tokens.css` in full, and open `docs/design/reference-dashboard.html` before
> writing any markup. Use only tokens from that file. No border radius, no blurred shadows, no
> third typeface, no rotation.

## Making it automatic (recommended)

Add one line to `AGENTS.md` so no one has to remember:

```md
- **UI work:** `docs/design/GEMBA-BOARD.md` is binding. Read it and `gemba-tokens.css` before
  writing any component. A UI diff that introduces a hex literal, a border radius or a blurred
  shadow is rejected.
```

## Prompt templates

**New screen**

> Build the *Corrective actions* screen for `apps/admin-web` in the Gemba Board design system
> (`docs/design/GEMBA-BOARD.md`, tokens in `gemba-tokens.css`, reference in
> `reference-dashboard.html`).
> Sections, in order: filter bar (owner, department, status) · overdue-first table with severity
> rails · a slip only if something is overdue · a by-owner share panel.
> Use real column names from `ARCHITECTURE.md`. Both themes. Phone width down to 400px.
> Follow §2 non-negotiables and §3 score semantics exactly — `N/A` is never zero.

**New component**

> Add a `<ZoneTile>` to `apps/admin-web/src/components`. Anatomy is fixed by
> `GEMBA-BOARD.md` §6 "Zone tile": label, figure in Archivo 900, delta in DM Mono, meta line,
> status band. Props: name, score (nullable), delta, leader, ncCount, selected, onSelect.
> Render the null-score case as the dashed pending tile. Tokens only — no hex literals.

**Review**

> Review this diff against `docs/design/GEMBA-BOARD.md`. Report violations only, with file:line:
> hex literals, border radius, blurred shadows, a third font family, mono used for a display
> figure, colour carrying meaning without a shape, more than one yellow slip per view, missing
> dark-theme tokens, `N/A` rendered as 0.

**When you want to extend the system rather than use it**

> Propose the smallest token addition that covers this case. Show why no existing token works.
> Do not add a colour if a shape (band, rail, chip, hatch) would carry the meaning instead.

## Acceptance checklist

Paste this as the definition of done for any UI task:

- [ ] Zero hex literals outside `gemba-tokens.css`
- [ ] Zero `border-radius`, zero blurred `box-shadow`
- [ ] Only Archivo + DM Mono; display figures are Archivo 900, mono only for small data
- [ ] Headings carry `font-stretch: 110–112%` and uppercase
- [ ] Renders correctly in both theme states (`data-theme="light"` and `data-theme="dark"`)
- [ ] Status reads without colour (band, rail, chip, or hatch present)
- [ ] At most one yellow slip, and only for something actionable
- [ ] `N/A` hatched and excluded from averages; not-started is a dashed tile, not a zero
- [ ] Digit columns use `tabular-nums`; deltas signed with U+2212
- [ ] Keyboard focus visible on every control; `prefers-reduced-motion` respected
- [ ] No horizontal page scroll at 400px; tables and charts scroll inside their own container

## Failure modes seen in practice

| What an agent does | Why it is wrong |
|---|---|
| Softens the shadow "for polish" | The hard offset *is* the magnet. Blur turns it into generic SaaS. |
| Rounds the corners a little | See non-negotiable 1. There is no small amount of rounding. |
| Sets big numbers in the mono face | Mono is data; the figure is display. This single swap dissolves the identity. |
| Uses the teal accent to brighten a chart | Accent is interaction only. Charts use score-band colours. |
| Adds a third font "for contrast" | Contrast comes from the width and weight axes of Archivo. |
| Shows an all-`NA` section as 0% | Destroys the Unit trend and misrepresents the audit. |
| Tilts a card to look like paper | This is a 5S product. Alignment is the argument. |
