# apps/field-mobile — agent brief

Read the root [`AGENTS.md`](../../AGENTS.md) first; it is not repeated here. This file covers
only what is specific to the field mobile app.

- React Native 0.8x + Expo (prebuild / custom dev client), expo-router, TypeScript.
  expo-camera for in-app live capture. The **only** gallery path is an overall corrective
  action's optional after-photo (`DECISIONS.md` R-38), through `src/lib/capture/gallery.ts`,
  the sole importer of `expo-image-picker`; every other photograph is a live capture.
  expo-sqlite + Drizzle with a hand-written `outbox` and `media_queue`.
- **Offline is the normal condition, not an error state.** Anything that can fail silently must
  be visible in the queue instead. Never show an auditor a spinner where a queued item belongs.
- **The device is not authoritative about scores.** Numbers computed on-device are display-only;
  the server recomputes on sync. Any screen where both could appear must say which it is showing.

## UI is built from the design system

[`DESIGN.md`](../../DESIGN.md) locks the system; [`docs/design/LEDGER.md`](../../docs/design/LEDGER.md)
is binding. `src/lib/ledger.ts` is the React Native port of `docs/design/ledger-tokens.css`
(same roles, camelCase), read through `useTheme()` in `src/lib/theme.ts`.

- **Never retype a hex value, radius or duration into a StyleSheet.** Use `theme.color.*`,
  `theme.radius.*`, `theme.dur.*`, `theme.family.*`.
- **Shape from the scale:** 22 big cards · 18 cards · 14 panels · 10 controls · 6 chips ·
  999 pills. Cards are flat; no shadows, no `elevation`.
- **Manrope only** (`@expo-google-fonts/manrope`, loaded in `app/_layout.tsx`); figures
  tabular, headline numbers 600.
- **Four score bands, four colours:** `bandOf()` returns the band, `bandInk` / `bandFill` /
  `bandTint` its colours; a status that is not a score passes a tone (`ok` / `warn` / `crit`).
  The band label is always shown. Past-due is `primaryInk` plus the words, never red.
- **Press feedback** is a short scale/opacity change (Reanimated), never a translate.
- **Touch targets are 48dp minimum**, and the primary action sits within thumb reach at the
  bottom of the screen, not in a header.
- **An all-`NA` section is `N/A` on a hatch and excluded from the average**, never 0.
- The theme follows the phone's setting; Profile → Theme overrides it (`theme-choice.ts`).
  Both palettes come from `ledger.ts`.

Definition of done for a UI task is the "Done means" list in `LEDGER.md`.
