import * as FileSystem from 'expo-file-system/legacy';
import type { MeResponse } from '@audit5s/contracts';

/**
 * The last `/auth/me` answer, so the app can open without a connection.
 *
 * Launch used to ask the server who is signed in and treat *any* failure as "nobody": an
 * auditor whose phone restarted the app inside a plant with no signal landed on the login
 * screen mid-audit (2026-09-28). Now only the server saying the session is over signs them
 * out; an unreachable server opens the app as it was.
 *
 * A file rather than the keystore: it is who you are and what your role may do — no
 * credential — and a Super Admin's permission list is larger than a keystore value should
 * be. The server still decides every request; this only paints the screens.
 */
const PATH = `${FileSystem.documentDirectory ?? ''}last-me.json`;

export async function loadLastMe(): Promise<MeResponse | null> {
  try {
    return JSON.parse(await FileSystem.readAsStringAsync(PATH)) as MeResponse;
  } catch {
    return null;
  }
}

export async function saveLastMe(me: MeResponse): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(PATH, JSON.stringify(me));
  } catch {
    // Without it the next offline launch asks for a sign-in, which is how it always was.
  }
}

export async function clearLastMe(): Promise<void> {
  try {
    await FileSystem.deleteAsync(PATH, { idempotent: true });
  } catch {
    // Nothing to clear.
  }
}
