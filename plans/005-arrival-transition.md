# 005 — Arrival highlight as a transition, not keyframes

- **Status**: DONE (S1, 2026-10-03)
- **Commit**: ffae30c
- **Severity**: LOW
- **Category**: Interruptibility (report §10.2 M5)
- **Estimated scope**: 1 file (CSS only), ~20 lines

## Problem

A row reached from a notification (Audits) or a report just queued (Reports) flashes with
`@keyframes gb-arrive`, 2.4 s. **Keyframes** are not an **interruptible animation**: when the
row's open state flips, `animation-name` swaps (`gb-arrive` → `gb-arrive-open`) and the flash
restarts from zero. Under reduced motion it was kept alive with a 10 ms / 1.6 s hack.

```css
/* apps/admin-web/src/styles.css:1739 — current */
.gb-tablewrap tr.gb-row--target td { animation: gb-arrive 2.4s ease-out both; }
@keyframes gb-arrive { 0%, 45% { background: var(--accent-soft); } 100% { background: transparent; } }
.gb-tablewrap tr.gb-row--target.gb-row--open td { animation-name: gb-arrive-open; }
@keyframes gb-arrive-open { 0%, 45% { background: var(--accent-soft); } 100% { background: var(--tile-2); } }
.gb-tablewrap tr.gb-row--target td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
```

## Target (deviation from M5's setTimeout, recorded)

M5 proposed adding the class from JS and removing it after 900 ms. Both call sites
(`features/audits/AuditsPage.tsx:190, :397`, `features/reports/ReportsPage.tsx:368`) put the
class on a row **when the row first appears** (a deep link, or the new snapshot's new row),
so a CSS **enter** transition gives the same result with no timer in feature files that other
sessions own:

```css
.gb-tablewrap tr.gb-row--target td {
  /* hold 900 ms, then settle over 600 ms: 1.5 s in all */
  box-shadow: inset 0 0 0 0 transparent;
  transition: box-shadow 600ms ease-out 900ms;
  @starting-style { box-shadow: inset 0 0 0 100vmax var(--accent-soft); }
}
.gb-tablewrap tr.gb-row--target td:first-child {
  box-shadow: inset 3px 0 0 var(--accent), inset 0 0 0 0 transparent;
  @starting-style { box-shadow: inset 3px 0 0 var(--accent), inset 0 0 0 100vmax var(--accent-soft); }
}
```

Why `box-shadow`, not `background-color`: the tint is an inset, zero-blur spread that covers
the cell above its background. The row's hover and open backgrounds stay instant (a delayed
`background-color` transition would hold every later hover on that row for 900 ms), and
opening or closing the row no longer restarts anything. Zero blur keeps it inside GEMBA §2.2.

The teal stays: `--accent-soft` is the selection colour and "the row you came for" is a
selection (GEMBA §2.6). The 3 px accent rail stays as the persistent, non-colour marker.

## Steps

1. Replace the five rules above with the target. Delete both `@keyframes`.
2. Delete the reduced-motion override for `gb-row--target` (plan 002).

## Boundaries

- Do NOT edit the TSX call sites.

## Verification

- **Feel check**: open `/audits?audit=<id>`: the row is tinted, holds about 0.9 s, fades over 0.6 s; the rail stays. Hover the row afterwards: the hover tint is instant. Toggle the row open during the fade: the fade carries on, it does not restart.
- **Reduced motion**: the fade still plays (colour only, no movement).
- **Done when**: `grep -n "gb-arrive" apps/admin-web/src/styles.css` → nothing.
