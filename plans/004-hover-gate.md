# 004 — Gate hover shadows to real pointers

- **Status**: DONE (S1, 2026-10-03)
- **Commit**: ffae30c
- **Severity**: LOW
- **Category**: Accessibility / touch (report §10.2 M4)
- **Estimated scope**: 2 files, ~15 lines

## Problem

On touch screens a tap fires `:hover`, and the **hover effect** sticks until the next tap
elsewhere: a tapped tile keeps a 5 px lifted shadow, which reads as "selected".

```css
/* gemba-tokens.css — current */
.gb-tile--interactive:hover{box-shadow:5px 5px 0 var(--hard)}
.gb-btn:hover{box-shadow:3px 3px 0 var(--hard)}
/* styles.css:1051 — current */
.gb-btn:hover { box-shadow: 3px 3px 0 var(--hard); }
```

## Target

Wrap each lift hover in `@media (hover: hover) and (pointer: fine) { … }`, the way
`styles.css` already gates `.gb-rowtoggle:hover` (`:1165`) and `.gb-picked button:hover` (`:1857`).

Scope is the lift hovers named by M4 (`.gb-btn`, `.gb-tile--interactive`). Background-tint
hovers on rows, nav links and menu items are not lifts and keep their behaviour (a menu
item's hover doubles as its focus style).

## Steps

1. Token file: move `.gb-tile--interactive:hover` and `.gb-btn:hover` into one `@media (hover:hover) and (pointer:fine)` block.
2. `styles.css`: same for `.gb-btn:hover`.

## Boundaries

- Do NOT touch `:focus-visible` rules; keyboard focus stays visible on every device.

## Verification

- **Mechanical**: Playwright with `hasTouch: true, isMobile: true`: `matchMedia('(hover: hover) and (pointer: fine)').matches` is false, and after a tap the tile's `box-shadow` is the resting 3 px (5 px only when `aria-pressed="true"`).
- **Feel check**: with a mouse, hover still lifts tiles and buttons.
