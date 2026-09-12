# apps/field-mobile — agent brief

Read the root [`AGENTS.md`](../../AGENTS.md) first; it is not repeated here. This file covers
only what is specific to the field mobile app.

- React Native 0.8x + Expo (prebuild / custom dev client), expo-router, TypeScript.
  expo-camera for in-app live capture only — there is no gallery path. expo-sqlite + Drizzle
  with a hand-written `outbox` and `media_queue`.
- **Offline is the normal condition, not an error state.** Anything that can fail silently must
  be visible in the queue instead. Never show an auditor a spinner where a queued item belongs.
- **The device is not authoritative about scores.** Numbers computed on-device are display-only;
  the server recomputes on sync. Any screen where both could appear must say which it is showing.

## UI is built from the design system

[`docs/design/GEMBA-BOARD.md`](../../docs/design/GEMBA-BOARD.md) is binding, including §8
"Porting the tokens", which is the only sanctioned way to get these values into React Native.

- Import the exported token object. **Never retype a hex value into a StyleSheet.**
- **No `borderRadius`.** Zero is the only value in this product.
- **The hard shadow, by platform.** iOS: `shadowOffset:{width:3,height:3}`, `shadowRadius:0`,
  `shadowOpacity:1`, `shadowColor:"rgba(29,27,22,0.22)"`. Android: `elevation` is always
  blurred and is therefore banned — use a second absolutely-positioned `View` offset 3px
  behind the tile.
- **Two families only**, loaded through `expo-font`: Archivo (display figures at weight 900)
  and DM Mono (small data). Load the static weights on mobile; the variable width axis is a
  web-only signature.
- **Touch targets are 48px minimum**, and the primary action sits within thumb reach at the
  bottom of the screen, not in a header.
- **Status reads without colour** — band, rail, chip or hatch — because the phone will be used
  in direct sunlight on a shop floor.
- **An all-`NA` section is `N/A` on a hatch and excluded from the average**, never 0.
- Theme follows the OS via `useColorScheme()`; both palettes come from the same exported object.

Definition of done for a UI task is the acceptance checklist in `GEMBA-BOARD.md`.
