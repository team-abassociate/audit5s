# The audit5s design system

**Status:** authoritative for `apps/admin-web`. `apps/field-mobile` is covered by §9.
**Files in this folder:**

| File | What it is | How to use it |
|---|---|---|
| [`gemba-tokens.css`](./gemba-tokens.css) | Every colour, border, shadow, radius, type role and primitive. | Copy verbatim. Never re-declare a value it already defines. |
| [`reference-dashboard.html`](./reference-dashboard.html) | **Superseded — see the banner in the file.** It renders the previous whiteboard treatment and is kept only as a record of it. | Do not copy from it. The running app is the reference. |
| This file | The rules, the component anatomy, and how to brief an agent. | Read §0–§3 before writing any UI. |

---

## 0. What changed, and what did not

The web app was originally built as a **Gemba Board**: the magnetic whiteboard by the
production line, rendered literally — a dry-erase ground with a 28px rule, rectangular
magnets with hard ink borders and zero-blur offset shadows, masking-tape markers, 900-weight
letter-spaced caps. It was internally consistent and it photographed well.

It was replaced, on the owner's instruction, with a **conventional corporate treatment**:
rounded corners, soft blurred elevation, grey-on-white surfaces, sentence case, lighter
type. The product is sold to plant management and read on office monitors, and the
whiteboard metaphor read as loud rather than as disciplined.

**What survived the change, unaltered:**

- Every score semantic in §3 — the bands, `N/A` exclusion, decimal places, server authority.
- The `gb-` class names and the component anatomy in §6. This was a change of material, not
  of structure, so no component was renamed and no markup moved.
- The token discipline itself: one file owns every value, and a literal in a component is
  still a bug. Only the values inside that file changed.
- Both themes, the accent-is-interaction-only rule, and status-is-never-colour-alone.

**What the old system forbade and this one requires:** border radius, and blurred shadows.
Any instruction elsewhere in the repository still banning those two is stale; this file and
`gemba-tokens.css` are the current contract.

## 1. The idea in one paragraph

A 5S audit is about a plant being orderly, so the interface argues by being orderly itself:
a calm grey ground, white cards with hairline borders and soft elevation, generous spacing,
and one amber slip for the single thing someone must act on. Nothing tilts, nothing is
hand-drawn, nothing sits off-grid. The restraint is the point — a dashboard that shouts at a
plant manager about their own scores is arguing against itself. Colour appears only where it
carries meaning, so when something is red it is genuinely red.

## 2. Non-negotiables

An agent that breaks any of these has not built this design system.

1. **Radius comes from a token.** `--r-sm` (6px) for controls, `--r` (8px) for surfaces, `--r-lg` (12px) for large panels, `--r-pill` for chips, dots and tracks. Never a literal.
2. **Elevation is soft and from a token.** `--shadow-1` at rest, `--shadow-2` on hover or selection, `--shadow-3` for overlays. Never a hand-written `box-shadow`, and never the old zero-blur offset.
3. **No rotation, no random offsets, no "organic" scatter.** Every object sits on the grid.
4. **Two families only:** Archivo (display + UI) and DM Mono (data). Never introduce a third.
5. **Display numerals are Archivo 700**, `letter-spacing:-.02em`, tabular. Mono is for *small* data only — table cells, timestamps, axis ticks, deltas. Getting this backwards is the most common way this system is built wrong.
6. **Sentence case.** Headings, labels and buttons are written the way a sentence is. The letter-spaced uppercase of the previous system is gone; do not reintroduce it "for emphasis".
7. **Colour is semantic, not decorative.** Green/amber/red mean score bands and nothing else. The teal accent (`--accent`) appears in focus rings, selection and the primary button — never as a decorative fill, never in a chart.
8. **One amber slip per view**, and only when a human must do something. Two slips means nothing is urgent.
9. **Status is shape + colour.** A band, a rail, an outlined chip — colour alone never carries meaning (colour-blind auditors, projector screens, sunlight on a phone).
10. **Every value is a token.** A literal hex, radius or shadow in a component is a bug.
11. **Both themes, always.** Never invert; the dark palette is its own set of values, already in the token file.

## 3. Score semantics

There are **four** bands, not three. `packages/domain/src/rating-scale.ts` owns the scale
(R-6b) and is the only file allowed to name a colour; this table must follow it, never lead
it. The design system carries three colour pairs, so the two upper bands share `--ok` and the
**label** is what keeps all four apart — which is why status must read without colour.

| Band | Range | Colour class | Label shown |
|---|---|---|---|
| Outstanding | ≥ 90 | `--ok` / `--ok-band` | `Outstanding` |
| On Track | 75 – 89.9 | `--ok` / `--ok-band` | `On Track` |
| Improving | 60 – 74.9 | `--warn` / `--warn-band` | `Improving` |
| Needs Support | < 60 | `--crit` / `--crit-band` | `Needs Support` |
| Target line | 90 (`TARGET`) | `--crit-band`, dashed, on charts only | — |
| Not applicable | — | `.gb-na` hatch | `N/A` |
| Not started | — | dashed tile, `--ink-3` | `—` |

Rules that come from the product, not from taste:

- **`N/A` is not zero.** A section where every question is `NA` renders `N/A` on a 45° hatch and is **excluded from the average**. Any UI that shows it as `0` is wrong (`ARCHITECTURE.md` §1.5-D4).
- Scores are `numeric(6,3)`. Show **one decimal** in tiles and charts, **two** in audit tables and registers, **three** in a true ledger. Never round in a way that changes a band — the band is always computed from the raw value, never re-derived from the formatted string.
- **The server owns the score.** Device-computed numbers are display-only and must be labelled as such wherever both could appear.
- Deltas use a real minus sign (`−`, U+2212) and always carry a sign, including `+0.0`.
- Every column of digits gets `font-variant-numeric: tabular-nums`.

## 4. Type

```html
<link rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..700&family=DM+Mono:wght@400;500&display=swap">
```

The weight axis now stops at 700 — nothing in the system is set above it, and loading to 900
would only invite its reuse.

| Role | Family | Size | Weight | Other |
|---|---|---|---|---|
| Page / section heading | Archivo | 17px | 600 | sentence case, `letter-spacing:-.01em` |
| Panel heading | Archivo | 15px | 600 | sentence case |
| Display figure (KPI, tile score, stat) | Archivo | 20–26px | **700** | `letter-spacing:-.02em`, tabular |
| Body | Archivo | 14px | 400 | `line-height:1.5` |
| Secondary / helper | Archivo | 12.5–13px | 400 | `--ink-2` |
| Field label | Archivo | 12px | 500 | sentence case, no tracking, `--ink-3` |
| Table + small data | DM Mono | 12–13px | 400–500 | tabular |
| Chip / badge / tape | Archivo | 12px | 500 | sentence case, pill radius |

The width axis is left at 100%. The previous system stretched headings to 110–118% as a
signature; that is exactly the effect the restyle removed, so do not reintroduce it.

## 5. Layout

- Base unit **8px**. Gaps are 8 / 16 / 24 / 28. Page padding 22–28px, 16px at phone width.
- Shell: fixed **216px** rail + fluid main. Rail becomes a horizontal scrolling strip below 860px.
- Topbar is sticky, hairline bottom border, and holds: title, scope selectors (Unit, cycle), sync pill, theme switch, secondary action, primary action, identity chip. **Every control in it shares one height (`--ctl-h`, 34px)** and aligns on it — mixed control heights on a centred flex row read as misalignment even when nothing is off-grid.
- Content is a single column of **sections**. Each section = heading block with a hairline underline, then its content 14px below.
- Tile grids: `repeat(auto-fit, minmax(178px,1fr))` for KPIs, fixed 3-up for the department board (2-up ≤860px, 1-up ≤440px).
- Detail panels are sticky at `top:86px` on desktop, static below 1180px.
- Only tables and charts may scroll horizontally, each in its own `overflow-x:auto` container.

## 6. Components

Anatomy is fixed; the data is not. The anatomy below is still correct — the restyle changed
material, not structure — but `reference-dashboard.html` renders it in the retired treatment,
so read `apps/admin-web/src/features/dashboard/DashboardPage.tsx` for working markup instead.

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
reaches (40/60/80/100), dashed target rule at 85 labelled `TARGET 85`, 2.6px line, 12% area
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

## 9. Field mobile

`apps/field-mobile` was **not** restyled, and that is deliberate rather than an omission.

The port lives in `apps/field-mobile/src/lib/gemba.ts` — React Native has no CSS, so the
tokens are a TypeScript object there rather than an import of `gemba-tokens.css`. It still
carries the whiteboard values: heavy borders, high contrast, large figures.

Keep it that way until someone decides otherwise. The phone is used by an auditor standing
on a plant floor, often in direct sunlight, frequently wearing gloves, at arm's length. High
contrast and large touch targets are a legibility requirement there, not a style. The web
dashboard is read on an office monitor by someone sitting down, which is why it could afford
to become quiet and the phone cannot.

The consequence is that the two apps no longer look alike. That is a real cost and it is
accepted knowingly: if the mobile app is ever restyled to match, the score semantics in §3
must survive the move unchanged, exactly as they did here.

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
- [ ] Zero literal `border-radius` or `box-shadow` values — both come from tokens
- [ ] Only Archivo + DM Mono; display figures are Archivo 700, mono only for small data
- [ ] Headings and labels are sentence case; no letter-spaced uppercase anywhere
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
| Writes a literal `box-shadow` or `border-radius` | Both are tokens now. A hand-written value is the same bug a hex literal is, and it drifts the moment the scale changes. |
| Reinstates the hard offset shadow or square corners | That system was deliberately retired (§0). Restoring a piece of it leaves two design systems in one screen. |
| Adds letter-spaced uppercase "for emphasis" | Sentence case is non-negotiable 6. Emphasis comes from weight and colour. |
| Sets big numbers in the mono face | Mono is data; the figure is display. This single swap dissolves the identity. |
| Uses the teal accent to brighten a chart | Accent is interaction only. Charts use score-band colours. |
| Adds a third font "for contrast" | Contrast comes from the width and weight axes of Archivo. |
| Shows an all-`NA` section as 0% | Destroys the Unit trend and misrepresents the audit. |
| Rounds one component more than the scale allows | Four radius values exist. A fifth is drift, not taste. |
