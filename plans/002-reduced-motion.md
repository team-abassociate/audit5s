# 002 — Reduced motion that reduces, not removes

- **Status**: DONE (S1, 2026-10-03)
- **Commit**: ffae30c
- **Severity**: MEDIUM
- **Category**: Accessibility (report §10.2 M2, finding G16)
- **Estimated scope**: 2 files, ~30 lines

## Problem

Under `prefers-reduced-motion: reduce` every transition and animation is deleted, including
fades that only change opacity and the press feedback that confirms a click. **Reduced motion**
means fewer, gentler animations: drop movement, keep opacity and colour.

```css
/* docs/design/gemba-tokens.css (end) — current */
@media (prefers-reduced-motion:reduce){ *{transition:none !important;animation:none !important} }

/* apps/admin-web/src/styles.css:1932 — current */
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
  .gb-tablewrap tr.gb-row--target td { animation-duration: 0.01s; animation-delay: 1.6s; }
}
```

## Target

1. Remove movement at each of its three sources:
   - **Press feedback** translates by `var(--press)` (plan 003). Reduced motion sets
     `--press: 0px` on `:root`: every press keeps its shadow collapse and loses its travel.
   - **Enter** transitions (`.gb-row-expand > td > *`, `.gb-pdfpanel`, `.gb-dialog`, `.gb-menu`)
     start from a `translate`/`scale`. Reduced motion: `transition: opacity 150ms ease-out; transform: none`
     — a plain **fade in**, no slide, no scale.
   - The row-toggle chevron **rotate** (`.gb-rowtoggle-chev`) becomes instant: `transition: none`.
2. Keyframe animations, if any are added later, collapse to one 1 ms iteration:
   `*, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; animation-delay: 0s !important; }`.
3. Opacity and colour transitions stay. The `.gb-pdf-page canvas` **crossfade** is capped at 150 ms;
   hover/press shadow changes stay at `--motion` (143 ms).
4. The arrival highlight (plan 005) is a colour fade with no movement; it stays.

## Repo conventions to follow

- `--motion: 143ms` is the system's one duration; 150 ms is the ceiling for reduced-motion fades.
- The token file owns the primitives (`.gb-btn`, `.gb-tile--interactive`); `styles.css` owns app components. Each file's reduced-motion block covers only its own rules.

## Steps

1. `gemba-tokens.css`: replace the reduced-motion block with `:root{--press:0px}` plus the animation collapse rule (target 2).
2. `styles.css`: replace the reduced-motion block with target 1 (enter fades, chevron) and the canvas cap; delete the `gb-row--target` 10 ms / 1.6 s override.

## Boundaries

- Do NOT add transitions to elements that have none.
- Do NOT remove focus outlines or any colour change.

## Verification

- **Mechanical**: eslint, typecheck, admin-web tests.
- **Feel check** (Playwright `reducedMotion: 'reduce'`, or DevTools Rendering → emulate):
  - Pressing a button: the shadow collapses, the button does not move (`transform` stays `none` while `:active`).
  - Opening the Reports preview, a dialog, a row menu: it fades; it does not slide or scale.
  - Expanding an audit row: content fades in, the chevron flips instantly.
- **Done when**: no rule anywhere sets `transition: none !important` on `*`.
