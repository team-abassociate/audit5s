import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { LOCAL_MIGRATIONS } from './migrations';
import * as schema from './schema';

/**
 * The device database, as Drizzle's SQLite dialect over a driver we supply.
 *
 * The proxy driver is used rather than `drizzle-orm/expo-sqlite` directly for one
 * reason: it makes the local schema and every query against it testable off-device. The
 * app supplies an `expo-sqlite` executor; the tests supply a `node:sqlite` one; the SQL
 * Drizzle generates is identical in both, so a broken query fails in CI rather than in a
 * plant with no signal.
 */
export type LocalDatabase = SqliteRemoteDatabase<typeof schema>;

/**
 * The one thing a driver must do. It mirrors `expo-sqlite`'s async surface closely enough
 * that the adapter below is a handful of lines.
 */
export interface SqliteExecutor {
  /** Runs statements with no result — DDL and pragmas. */
  exec(sql: string): Promise<void>;
  /** Runs one parameterised statement and returns its rows as arrays of column values. */
  query(sql: string, params: unknown[]): Promise<unknown[][]>;
  /** Runs one parameterised statement for its effect. */
  run(sql: string, params: unknown[]): Promise<void>;
  /** Reads SQLite's own `user_version`. */
  userVersion(): Promise<number>;
  setUserVersion(version: number): Promise<void>;
}

export function createLocalDatabase(executor: SqliteExecutor): LocalDatabase {
  return drizzle(
    async (sql, params, method) => {
      if (method === 'run') {
        await executor.run(sql, params);
        return { rows: [] };
      }
      const rows = await executor.query(sql, params);
      // `get` wants a single row, the others want the list. Drizzle maps positionally,
      // which is why the executor returns arrays of column values rather than objects.
      return { rows: method === 'get' ? (rows[0] ?? []) : rows };
    },
    { schema, casing: 'snake_case' },
  );
}

/**
 * Applies every migration the device has not seen, in order, each inside a transaction.
 *
 * `user_version` is SQLite's own counter, so the record of what has been applied survives
 * anything short of deleting the database file — including the app being replaced by an
 * OTA update mid-migration.
 */
export async function migrateLocalDatabase(executor: SqliteExecutor): Promise<number> {
  await executor.exec('PRAGMA journal_mode = WAL');
  await executor.exec('PRAGMA foreign_keys = ON');

  let current = await executor.userVersion();

  for (const migration of LOCAL_MIGRATIONS) {
    if (migration.version <= current) continue;

    await executor.exec('BEGIN');
    try {
      for (const statement of migration.statements) {
        await executor.exec(statement);
      }
      await executor.exec('COMMIT');
    } catch (error) {
      await executor.exec('ROLLBACK');
      throw error;
    }

    await executor.setUserVersion(migration.version);
    current = migration.version;
  }

  return current;
}

export { schema };
