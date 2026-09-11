import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { idempotencyKeys, type Database } from '@audit5s/db';
import { DATABASE } from '../../infrastructure/database/database.module';

export interface IdempotencyRow {
  key: string;
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown;
  completedAt: Date | null;
}

/**
 * Data access for `idempotency_key`.
 *
 * The scope predicate here is the RLS policy rather than a resolver: rows are keyed to
 * their owner, and replaying another user's stored response would be a disclosure. Every
 * method sets the actor context so that policy applies.
 */
@Injectable()
export class IdempotencyRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async find(userId: string, key: string): Promise<IdempotencyRow | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.actor_id', ${userId}, true)`);
      const [row] = await tx
        .select({
          key: idempotencyKeys.key,
          requestHash: idempotencyKeys.requestHash,
          responseStatus: idempotencyKeys.responseStatus,
          responseBody: idempotencyKeys.responseBody,
          completedAt: idempotencyKeys.completedAt,
        })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, key))
        .limit(1);
      return row ?? null;
    });
  }

  async claim(input: {
    key: string;
    userId: string;
    endpoint: string;
    requestHash: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.actor_id', ${input.userId}, true)`);
      await tx.insert(idempotencyKeys).values({
        key: input.key,
        userId: input.userId,
        endpoint: input.endpoint,
        requestHash: input.requestHash,
        expiresAt: sql`now() + interval '48 hours'` as unknown as Date,
      });
    });
  }

  async complete(input: {
    key: string;
    userId: string;
    status: number;
    body: unknown;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.actor_id', ${input.userId}, true)`);
      await tx
        .update(idempotencyKeys)
        .set({
          responseStatus: input.status,
          responseBody: input.body as never,
          completedAt: sql`now()` as unknown as Date,
        })
        .where(
          and(eq(idempotencyKeys.key, input.key), eq(idempotencyKeys.userId, input.userId)),
        );
    });
  }

  async release(key: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.actor_id', ${userId}, true)`);
      await tx
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId)));
    });
  }
}
