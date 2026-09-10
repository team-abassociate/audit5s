import { DatabaseSync } from 'node:sqlite';
import type { SqliteExecutor } from './local-database';

/**
 * A `node:sqlite` driver, so the local schema and every query against it can be tested
 * off-device.
 *
 * This is not a fake: it is real SQLite executing the SQL Drizzle generates. What it
 * replaces is the React Native runtime, not the database — which is the part worth
 * testing, because a query that is wrong on a phone in a plant with no signal is the most
 * expensive kind of bug this project can ship.
 *
 * It never runs on a device: nothing under `src/app` imports it, and `node:sqlite` does
 * not exist in the Hermes runtime.
 */
export function createNodeExecutor(filename = ':memory:'): SqliteExecutor & { close(): void } {
  const database = new DatabaseSync(filename);

  return {
    exec(sql) {
      database.exec(sql);
      return Promise.resolve();
    },
    query(sql, params) {
      const rows = database.prepare(sql).all(...(params as never[])) as Array<
        Record<string, unknown>
      >;
      return Promise.resolve(rows.map((row) => Object.values(row)));
    },
    run(sql, params) {
      database.prepare(sql).run(...(params as never[]));
      return Promise.resolve();
    },
    userVersion() {
      const [row] = database.prepare('PRAGMA user_version').all() as Array<{
        user_version: number;
      }>;
      return Promise.resolve(row?.user_version ?? 0);
    },
    setUserVersion(version) {
      database.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
      return Promise.resolve();
    },
    close() {
      database.close();
    },
  };
}
