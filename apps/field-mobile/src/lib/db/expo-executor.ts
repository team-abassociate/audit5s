import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';
import type { SqliteExecutor } from './local-database';

/**
 * The `expo-sqlite` driver.
 *
 * Plain `expo-sqlite`, not SQLCipher: DECISIONS.md R-4 settles that the device database is
 * unencrypted, because an encrypted store that the app must be able to open unattended
 * holds its own key, and the real control is the OS keystore plus remote device
 * revocation.
 */
export async function openExpoExecutor(
  name = 'audit5s.db',
): Promise<SqliteExecutor & { close(): Promise<void> }> {
  const database = await openWithRetry(name);

  return {
    async exec(sql) {
      await database.execAsync(sql);
    },
    async query(sql, params) {
      // `getAllAsync` returns objects keyed by column name; Drizzle's proxy driver maps
      // results positionally, so the values are taken in the row's own key order — which
      // is SQLite's column order for the statement.
      const rows = await database.getAllAsync<Record<string, unknown>>(sql, params as never[]);
      return rows.map((row) => Object.values(row));
    },
    async run(sql, params) {
      await database.runAsync(sql, params as never[]);
    },
    async userVersion() {
      const row = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      return row?.user_version ?? 0;
    },
    async setUserVersion(version) {
      // A pragma cannot take a bound parameter, and `version` is an integer from our own
      // migration list, never from input.
      await database.execAsync(`PRAGMA user_version = ${Math.trunc(version)}`);
    },
    async close() {
      await database.closeAsync();
    },
  };
}

/**
 * In a browser the files live in OPFS, and expo-sqlite's worker locks the whole store for as
 * long as the page lives — closing the database does not let go. So one tab at a time: the
 * tab opening it asks any older tab to give it up, and that tab reloads (the only thing that
 * frees the lock) into "open in another tab" — see `yieldedToAnotherTab`. The retries ride
 * out the moment before the old page is gone.
 */
async function openWithRetry(name: string): Promise<SQLite.SQLiteDatabase> {
  if (Platform.OS === 'web') claimFromOtherTabs();
  for (let attempt = 0; ; attempt++) {
    try {
      return await SQLite.openDatabaseAsync(name);
    } catch (caught) {
      if (Platform.OS !== 'web' || attempt >= 10) throw caught;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

const TABS = 'audit5s-local-db';
const YIELDED = 'audit5s-local-db-yielded';
interface TabChannel {
  postMessage(message: string): void;
  onmessage: (() => void) | null;
}
// Browser globals, typed here: the app compiles without the DOM lib.
const browser = globalThis as unknown as {
  BroadcastChannel?: new (name: string) => TabChannel;
  location: { reload(): void };
};
let channel: TabChannel | null = null;

/** Web: this tab gave the database to a newer one, and must not take it back unasked. */
export function yieldedToAnotherTab(): boolean {
  try {
    return Platform.OS === 'web' && sessionStorage.getItem(YIELDED) === '1';
  } catch {
    return false;
  }
}

function claimFromOtherTabs(): void {
  try {
    sessionStorage.removeItem(YIELDED);
  } catch {
    // Storage blocked: this tab just won't remember it yielded.
  }
  if (!browser.BroadcastChannel) return;
  if (!channel) {
    channel = new browser.BroadcastChannel(TABS);
    channel.onmessage = () => {
      try {
        sessionStorage.setItem(YIELDED, '1');
      } catch {
        // Without the flag the reload would take the database straight back; stay put instead.
        return;
      }
      browser.location.reload();
    };
  }
  channel.postMessage('take');
}

/**
 * The file that holds one person's work on this phone (0025: a phone is shared).
 *
 * Separate files rather than an owner column: nothing written while A is signed in can be
 * read, shown or pushed while B is — by construction, not by remembering a WHERE clause
 * in every query of a store that has dozens.
 */
export function databaseNameFor(userId: string): string {
  return `audit5s-${userId}.db`;
}

/** The single file every build before 0025 wrote, whoever was signed in. */
const SHARED_DATABASE = 'audit5s.db';

/**
 * Hands the pre-0025 file to its owner, once.
 *
 * That file holds whatever the phone recorded before it knew people apart, and the person
 * it was being synced as is whoever the app was signed in as when it updated — the first
 * person this build resolves, whether by the stored session or by signing in. It is
 * renamed, never copied or deleted: the data exists in exactly one place throughout.
 */
export async function adoptSharedDatabase(userId: string): Promise<void> {
  // A browser never ran a pre-0025 build.
  if (Platform.OS === 'web') return;
  const directory = `${FileSystem.documentDirectory}SQLite/`;
  const shared = await FileSystem.getInfoAsync(`${directory}${SHARED_DATABASE}`);
  if (!shared.exists) return;

  const own = await FileSystem.getInfoAsync(`${directory}${databaseNameFor(userId)}`);
  if (own.exists) return;

  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${directory}${SHARED_DATABASE}${suffix}`;
    if ((await FileSystem.getInfoAsync(from)).exists) {
      await FileSystem.moveAsync({ from, to: `${directory}${databaseNameFor(userId)}${suffix}` });
    }
  }
}
