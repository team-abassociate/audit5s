# 003 — One press: a --press token of 3px

- **Status**: DONE (S1, 2026-10-03)
- **Commit**: ffae30c
- **Severity**: LOW
- **Category**: Cohesion & tokens (report §10.2 M3)
- **Estimated scope**: 3 files, ~12 lines

## Problem

GEMBA §2.2: a pressed object loses its shadow and sinks `translate(3px,3px)`. In the product
the **press feedback** sinks 3 px on tiles, 2 px on buttons and close buttons, and one control
**scales** to 0.9 — a different physical metaphor (Gemba presses by translation).

```css
/* gemba-tokens.css — current */
.gb-tile--interactive:active{box-shadow:0 0 0 var(--hard);transform:translate(3px,3px)}
.gb-btn:active{box-shadow:0 0 0 var(--hard);transform:translate(2px,2px)}
/* styles.css — current */
.gb-btn:active            { box-shadow: 0 0 0 var(--hard); transform: translate(2px, 2px); }   /* :1054 */
.gb-pdfpanel-close:active { box-shadow: none;              transform: translate(2px, 2px); }   /* :1258 */
.gb-dialog-close:active   { box-shadow: 0 0 0 var(--hard); transform: translate(2px, 2px); }   /* :1493 */
.gb-choice label:has(input:checked) { box-shadow: 0 0 0 var(--hard); transform: translate(2px, 2px); } /* :1532, the pressed magnet */
.gb-picked button:active  { transform: scale(0.9); }                                            /* :1854 */
```

## Target

```css
/* gemba-tokens.css :root, beside --motion */
--press:3px;   /* how far a pressed object sinks; 0 under reduced motion */
```

Every pressed state: `box-shadow: 0 0 0 var(--hard); transform: translate(var(--press), var(--press));`.
`.gb-picked button` (a borderless "×" with no shadow) uses the same translate with
`transition: transform var(--motion) ease-out`. `.gb-pdfpanel-close` gains the
`box-shadow`/`transform` transition the dialog close button already has.

## Steps

1. Add `--press:3px` to the token file's `:root`; point `.gb-tile--interactive:active` and `.gb-btn:active` at it.
2. In `styles.css`, rewrite the five rules above to the target.

## Boundaries

- Do NOT change shadow sizes at rest or on hover.

## Verification

- **Mechanical**: `grep -n "translate(2px" apps/admin-web/src/styles.css docs/design/gemba-tokens.css` → nothing; `grep -n "scale(0.9)"` → nothing.
- **Feel check**: hold the mouse on a button, a zone tile, a dialog close, an auditor chip's ×: each sinks the same 3 px; nothing shrinks.
- **Done when**: every pressed transform reads `translate(var(--press), var(--press))`.
