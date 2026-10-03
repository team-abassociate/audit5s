# 001 — Fill the progress meter with scaleX, not width

- **Status**: DONE (S1, 2026-10-03)
- **Commit**: ffae30c
- **Severity**: MEDIUM
- **Category**: Performance (report §10.2 M1)
- **Estimated scope**: 2 files, ~25 lines

## Problem

The audit-progress meter animates `width`, which is **layout thrashing**: every frame of the
240 ms tween re-runs layout for the row it sits in.

```css
/* apps/admin-web/src/styles.css:1776 — current */
.gb-meter { display: flex; height: 6px; max-width: 420px; background: var(--board); border: 1px solid var(--edge-soft); }
.gb-meter i { display: block; background: var(--ok-band); transition: width 240ms cubic-bezier(0.23, 1, 0.32, 1); }
.gb-meter i.gb-meter--going { background: var(--warn-band); }
```

```tsx
// apps/admin-web/src/features/audits/AuditProgress.tsx:65 — current
<div className="gb-meter" aria-hidden>
  <i style={{ width: `${live.length ? (done / live.length) * 100 : 0}%` }} />
  <i className="gb-meter--going" style={{ width: `${live.length ? (going / live.length) * 100 : 0}%` }} />
</div>
```

The meter holds **two** segments on one track (completed, then in progress), laid out by flex.
It is the only `.gb-meter` in the app (the board's `.gb-track` / `.gb-prog` bars do not
transition, so they are out of scope).

## Target

Each segment spans the whole track and is drawn by **compositing** only: `scaleX` for its
length, `translateX` for where it starts. Both are fractions 0–1 set on the `<i>` itself.

```css
.gb-meter { position: relative; height: 6px; max-width: 420px; background: var(--board); border: 1px solid var(--edge-soft); overflow: hidden; }
.gb-meter i {
  position: absolute; inset: 0;
  background: var(--ok-band);
  transform-origin: left center;
  transform: translateX(calc(var(--at, 0) * 100%)) scaleX(var(--v, 0));
  transition: transform 240ms cubic-bezier(0.23, 1, 0.32, 1);
}
.gb-meter i.gb-meter--going { background: var(--warn-band); }
```

`translateX(%)` resolves against the segment's own width (the track), and the transform list
applies right to left, so the segment is scaled from its left edge and then moved to `--at`.
The in-progress segment starts where the completed one ends, exactly as before.

## Repo conventions to follow

- The strong ease-out is `cubic-bezier(0.23, 1, 0.32, 1)` (e.g. `.gb-rowtoggle-chev`, `styles.css:1174`). Keep 240 ms.
- No hex literals; colours stay `--ok-band` / `--warn-band`.

## Steps

1. Replace the three `.gb-meter` rules in `styles.css` with the target above.
2. In `AuditProgress.tsx`, compute `doneShare = live.length ? done / live.length : 0` and
   `goingShare = live.length ? going / live.length : 0`; render
   `<i style={{ '--v': doneShare } as CSSProperties} />` and
   `<i className="gb-meter--going" style={{ '--at': doneShare, '--v': goingShare } as CSSProperties} />`.

## Boundaries

- Do NOT change colours, heights, the copy above the meter, or any other bar.
- Do NOT add dependencies.

## Verification

- **Mechanical**: `pnpm exec eslint .`, `pnpm -r typecheck`, `pnpm --filter @audit5s/admin-web test`.
- **Layout probe**: with CDP `Performance.getMetrics`, change `--v` on a meter segment and confirm `LayoutCount` does not grow while the transition runs.
- **Feel check**: expand an audit row on `/audits`; green grows from the left edge and amber begins where green ends. At 10 % playback no segment drifts or overlaps.
- **Done when**: no `width` transition remains on `.gb-meter`, and the segments sit where they did before.
