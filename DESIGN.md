# DESIGN.md — the locked design system

**System:** Ledger (maroon `#882627` + apricot `#FFB380`), light and dark.
**Status:** locked by the owner, 2026-11-01 (DECISIONS.md R-76). Do not re-pick a theme,
palette, typeface or shape scale; build from what is here.

| What | Where |
| --- | --- |
| Rules (read first) | [`docs/design/LEDGER.md`](./docs/design/LEDGER.md) |
| Web tokens | [`docs/design/ledger-tokens.css`](./docs/design/ledger-tokens.css), imported by `apps/admin-web/src/styles.css` |
| Phone tokens | `apps/field-mobile/src/lib/ledger.ts` (same roles, camelCase), read through `useTheme()` |
| Score bands | `packages/domain` `RATING_BANDS` → `apps/admin-web/src/lib/bands.ts`, `ledger.ts` `bandOf` |
| Printed report | `packages/domain` `BRAND_TOKENS` — separate, not part of this system |

## Token roles

`--canvas` `--ground` `--surface` `--chip` · `--ink` `--on-ink` `--ink-2` `--muted` ·
`--rule` `--rule-soft` · `--primary` `--primary-hover` `--on-primary` `--primary-ink`
`--primary-ink-hover` · `--secondary` `--on-secondary` `--secondary-soft`
`--on-secondary-soft` · `--focus` · `--band-{outstanding,on-track,improving,needs-support}`
and `-tint` · `--font-ui` · `--radius-{card-lg,card,panel,control,chip,pill}` ·
`--shadow-frame` · `--dur-micro` `--dur-short` `--ease-out`.

## Open choice for the owner

Past-due text is maroon (`--primary-ink`, apricot in dark) plus the words "past due"; the
reference board drew it red. Red is a score colour, so maroon is the default until the owner
says otherwise.
