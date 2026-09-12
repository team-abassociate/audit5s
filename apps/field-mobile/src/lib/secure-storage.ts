import * as SecureStore from 'expo-secure-store';

/**
 * Credential storage, backed by the Android Keystore (STACK.md §2).
 *
 * Tokens live here and never in SQLite. DECISIONS.md R-4 settles that the local database
 * is plain `expo-sqlite` with no SQLCipher, which is exactly why this boundary matters:
 * business rows are readable on a rooted device, so nothing that grants access may sit
 * among them.
 */

const KEYS = {
  session: 'audit5s.session',
  deviceId: 'audit5s.deviceId',
} as const;

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
}

async function readString(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    // A keystore read can fail on a device whose secure hardware was reset. Treat it as
    // "no session" and make the user sign in again, rather than crashing on launch.
    return null;
  }
}

async function writeString(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

export async function loadSession(): Promise<StoredSession | null> {
  const raw = await readString(KEYS.session);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await writeString(KEYS.session, JSON.stringify(session));
}

export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEYS.session);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The install's device ID: client-generated, stable for the life of the install, and the
 * primary key of the `device` row on the server. A reinstall is deliberately a new device
 * — that is what makes "sync from the owning device" (D7) a meaningful instruction.
 */
export async function getDeviceId(): Promise<string> {
  const existing = await readString(KEYS.deviceId);
  if (existing) return existing;

  const generated = randomUuidV4();
  await writeString(KEYS.deviceId, generated);
  return generated;
}

/**
 * UUIDv4 from `crypto.getRandomValues`. Hermes defines no global `crypto`, so the app
 * entry (`src/app/_layout.tsx`) installs `expo-crypto` as one before anything runs.
 * Written out rather than pulled from a polyfill package for something this small.
 */
function randomUuidV4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
