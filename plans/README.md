# Motion plans — UX audit 2026-10-03 (report §10.2, M1–M5)

> **⛔ Kaizen work: `feat/kaizen` is the main branch for Kaizen.** Never commit, push, merge
> or open a PR to `main`: `main` deploys to the production VPS that clients use for 5S. Work
> only on your device branch (`kaizen/krxna` on Device A, `kaizen/geetahuja` on Device B), and PR
> it into `feat/kaizen`. Only the owner
> merges `feat/kaizen` → `main`, by hand, on release day. Plan:
> [`plans/kaizen-module.md`](kaizen-module.md) (BRANCH RULE).

Written by session S1 with `improve-animations` in plan mode (the report had already vetted
the findings, so there was no audit pass). Commit stamp `ffae30c`. Effect names follow
`animation-vocabulary`.

**Reconciled by S17 on 2026-10-06 against `main` 2c5f133: all five still hold.** The
meter fills by `scaleX` (`styles.css` `.gb-meter i`); `--press` lives in `gemba-tokens.css`
and is zeroed under reduced motion; lift hovers sit behind `(hover: hover) and (pointer: fine)`;
the arrival highlight is a `box-shadow` transition with `@starting-style`. The "current"
line numbers inside each plan describe the code before S1 and are left as written.

| # | Plan | Severity | Status |
|---|---|---|---|
| 001 | [Fill the progress meter with scaleX, not width](001-meter-scalex.md) — layout thrashing → compositing | MEDIUM | DONE (S1) |
| 002 | [Reduced motion that reduces, not removes](002-reduced-motion.md) — G16 | MEDIUM | DONE (S1) |
| 003 | [One press: a --press token of 3px](003-press-token.md) — press feedback | LOW | DONE (S1) |
| 004 | [Gate hover shadows to real pointers](004-hover-gate.md) — hover effect on touch | LOW | DONE (S1) |
| 005 | [Arrival highlight as a transition](005-arrival-transition.md) — interruptible animation | LOW | DONE (S1) |

## Order and dependencies

003 → 002 (002 zeroes `--press`, which 003 introduces) → 005 → 001 → 004.
002 and 005 both delete the old `gb-row--target` reduced-motion override; do them together.
