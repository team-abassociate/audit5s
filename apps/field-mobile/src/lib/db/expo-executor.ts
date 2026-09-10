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
export async function openExpoExecutor(name = 'audit5s.db'): Promise<SqliteExecutor> {
  const database = await SQLite.openDatabaseAsync(name);

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
  };
}
