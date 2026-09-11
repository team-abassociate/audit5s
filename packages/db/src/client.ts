import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Database = ReturnType<typeof createDatabase>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export function createPool(config: PoolConfig): Pool {
  return new Pool(config);
}

export function createDatabase(pool: Pool) {
  return drizzle(pool, { schema });
}

/**
 * The actor context every RLS policy reads (see 0001_foundation.sql).
 *
 * `SET LOCAL` scopes these to the surrounding transaction, so they cannot leak to the next
 * request that borrows the same pooled connection. A transaction that never sets them sees
 * no rows at all, which is the intended fail-closed default.
 */
export interface ActorDbContext {
  actorId: string;
  actorRole: string;
}

export async function withActor<T>(
  db: Database,
  context: ActorDbContext,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config's third argument = true means "local to this transaction".
    await tx.execute(sql`SELECT set_config('app.actor_id', ${context.actorId}, true)`);
    await tx.execute(sql`SELECT set_config('app.actor_role', ${context.actorRole}, true)`);
    return work(tx);
  });
}

/**
 * The pre-authentication window. `/auth/login` must read a user row before any actor
 * exists, so the auth repository opts in explicitly. This unlocks the authentication
 * tables only — every business policy still requires a real actor, so a path that simply
 * forgets to set a context sees nothing rather than everything.
 */
export async function withAuthPhase<T>(
  db: Database,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.auth_phase', 'on', true)`);
    return work(tx);
  });
}
