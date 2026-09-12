import * as ExpoCrypto from 'expo-crypto';

/**
 * Installs a global `crypto` on Hermes.
 *
 * Hermes does **not** define one, and nothing in React Native adds it. Two places assume
 * it does — `secure-storage.ts`'s device id and `audit.repository.ts`'s UUIDv7 — and both
 * threw `ReferenceError: Property 'crypto' doesn't exist` on the first call. `getDeviceId()`
 * runs inside `api.ts`'s `send()`, which is every request the app makes, so the app could
 * not reach the server at all: the login screen reported "Could not reach the server",
 * which is what disguised a missing global as a network fault for a long time.
 *
 * This is a polyfill rather than an edit to those two call sites on purpose. They are pure
 * modules whose tests run in plain Node — where `globalThis.crypto` exists — so importing
 * a native Expo module into either would drag `react-native` into the test graph and break
 * three suites that have nothing to do with randomness. Installing the global once, at the
 * entry point, leaves the call sites honest and the tests runnable.
 *
 * `expo-crypto` is already a dependency (`media.ts` hashes with it), so this adds nothing
 * to the bundle that was not already in it.
 *
 * Guarded, because a runtime that already provides `crypto` — Node under Vitest, and any
 * future Hermes that gains one — must keep its own.
 */
function installCryptoPolyfill(): void {
  // The DOM `Crypto` type is not in this project's lib, so the shape is spelled out.
  type WebCrypto = { getRandomValues?: unknown; randomUUID?: unknown };
  const existing = (globalThis as { crypto?: WebCrypto }).crypto;
  if (existing?.getRandomValues) return;

  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...existing,
      getRandomValues: <T>(array: T): T => ExpoCrypto.getRandomValues(array as never) as T,
      randomUUID: () => ExpoCrypto.randomUUID(),
    },
    configurable: true,
    writable: true,
  });
}

// Runs on import. It is a side-effect module, imported first in `src/app/_layout.tsx`:
// ES imports are hoisted, so a bare `installCryptoPolyfill()` call placed among them
// would run *after* every other import had already been evaluated.
installCryptoPolyfill();
