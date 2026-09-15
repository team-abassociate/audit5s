#!/usr/bin/env tsx
/**
 * Migration runner.
 *
 * Migrations are plain `.sql` files in git, applied in filename order, each inside its own
 * transaction. There is one environment, and `drizzle-kit push` is never run against it
 * (DECISIONS.md, "Related: migrations") — the deploy step takes a pgBackRest snapshot
 * immediately before this runs.
 *
 * Connects as the *owner* role, not the application role: migrations create objects and
 * grant privileges, and the application role deliberately cannot.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function appliedMigrations(client: Client): Promise<Map<string, string>> {
  const { rows } = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migration',
  );
  return new Map(rows.map((row) => [row.name, row.checksum]));
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');
  const connectionString =
    process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? undefined;

  if (!connectionString) {
    throw new Error('Set DATABASE_MIGRATION_URL (preferred) or DATABASE_URL');
  }

  const sslMode = process.env.DATABASE_SSL ?? 'disable';
  const client = new Client({
    connectionString,
    ssl: sslMode === 'disable' ? undefined : { rejectUnauthorized: sslMode === 'require' },
  });
  await client.connect();

  try {
    await ensureLedger(client);
    const applied = await appliedMigrations(client);
    const migrations = loadMigrations();

    for (const migration of migrations) {
      const appliedChecksum = applied.get(migration.name);

      if (appliedChecksum) {
        // An applied migration that has since been edited is a mistake worth stopping on:
        // the database and the file no longer describe the same schema.
        if (appliedChecksum !== migration.checksum) {
          throw new Error(
            `${migration.name} was already applied but its contents have changed. ` +
              'Applied migrations are immutable; add a new migration instead.',
          );
        }
        console.log(`  = ${migration.name} (already applied)`);
        continue;
      }

      if (statusOnly) {
        console.log(`  + ${migration.name} (pending)`);
        continue;
      }

      console.log(`  + ${migration.name} applying…`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)', [
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
        console.log(`  + ${migration.name} applied`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
