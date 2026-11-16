# Ledger — the audit5s design system

Binding for every pixel in `apps/admin-web` and `apps/field-mobile` (owner ruling 2026-11-01,
DECISIONS.md R-76). It replaces the Gemba Board in full. Tokens:
[`ledger-tokens.css`](./ledger-tokens.css) (web) and `apps/field-mobile/src/lib/ledger.ts`
(phone), the same names in both. The printed report keeps its own palette
(`BRAND_TOKENS` in `packages/domain`).

## Rules

1. **Tokens only.** No hex literal, radius, shadow, duration or font name outside the two
   token files. A component asks for a role (`--surface`, `theme.color.primary`), never a value.
2. **Colour roles.** Maroon `--primary` is the fill for the selected nav item, headline cards
   and the primary button (white text). Maroon as *text* is `--primary-ink`: links, change
   figures. Apricot `--secondary` fills the avatar, neutral chart bars and accents on maroon;
   pale apricot `--secondary-soft` is the soft panel and the sidebar notice card. Everything
   else is ground, surface, chip, ink, ink-2, muted and the two rules.
3. **Four score bands, from `packages/domain` `RATING_BANDS` (90 / 75 / 60).** Outstanding
   green, On Track blue, Improving yellow, Needs Support red. Chips: tint background + band
   text. Bars: solid band colour. On a maroon card: the light tint. The band **label** is
   shown wherever a score is, so it reads without colour. All-`NA` is `N/A`, excluded, never 0.
4. **Red is a score colour.** It is not used for anything else that could be read as a score.
   Past-due text is `--primary-ink` plus the words "past due".
5. **Type: Manrope only**, 400–800; Noto Sans Devanagari for Devanagari text only (R-45 c).
   Tabular numerals for every figure. Headline numbers weight 600, tracking −0.03 to −0.04em.
   No mono face. Headings and labels are sentence case and untracked — no uppercase labels.
6. **Shape.** Radius 22 big cards · 18 cards · 14 panels · 10 controls, nav items, bars ·
   6 chips · 999 pills and round icon buttons. Cards are flat on the ground, edged by
   `--rule` where they need one. Only the outer app frame carries `--shadow-frame`.
7. **Icons:** 16px stroke icons, 1.5 stroke, `currentColor`.
8. **Focus:** every control gets an instant `:focus-visible` ring, 2px `--focus`, 2px offset.
9. **Motion:** transform and opacity only, `--dur-micro` 120ms (press, hover) and
   `--dur-short` 220ms (panels, sheets), ease-out. A press is a short scale/opacity change,
   never a translate. Reduced motion keeps feedback, drops movement. Motion (`motion/react`)
   is used only for exits and layout slides; it takes its timings from these tokens through
   `apps/admin-web/src/lib/motion.ts`. One exception: the phone's segmented pill also animates its
   width, because a scale would stretch its corners (plans/007).
10. **One fact per element.** No middle-dot strings ("Plant 2 · Pune" is two elements). A ▲/▼
    trend appears only where the app already computes that change.
11. **Controls:** 36–40px tall with 44px hit targets on the web, ≥48dp on the phone. One
    primary button style (maroon fill, radius 10); secondary is outlined.

## Themes

Light and dark ship together and every screen is checked in both. The theme follows the
device setting; the app's manual override (web: the shell's theme switch, `data-theme` on
`<html>`; phone: Profile → Theme) wins when set. Dark is its own palette, never an inversion:
maroon stays the fill, maroon-as-text becomes apricot, apricot fills carry `--on-secondary`
text, pale-apricot panels become `#3A2320` with apricot text, the ink pill inverts, the focus
ring is apricot and shadows are black. Every dark text/background pair reaches 4.5:1 (3:1
for bars); `apps/field-mobile/src/lib/ledger.test.ts` checks it.

## Done means

- [ ] No literal colour, radius, shadow or font outside the token files
- [ ] Renders in light and dark (`data-theme="light"`, `"dark"`, and no attribute)
- [ ] Every score shows its band label; `N/A` excluded, not-started is not a zero
- [ ] Digits tabular; deltas signed with U+2212
- [ ] Focus ring visible on every control; `prefers-reduced-motion` respected
- [ ] No horizontal page scroll at 400px; tables and charts scroll inside their container
