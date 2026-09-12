import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import { unitMemberships, units, users, type Database, type Transaction } from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type { ListMembershipsQuery, Role } from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

@Injectable()
export class MembershipsRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  async create(
    scope: ScopeContext,
    input: { userId: string; unitId: string; role: Role },
    afterWrite?: (tx: Transaction) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .insert(unitMemberships)
        .values({
          userId: input.userId,
          unitId: input.unitId,
          // The database trigger overrides this with the user's actual role, so a wrong
          // value here cannot corrupt the predicates built on it.
          role: input.role,
          assignedByUserId: scope.actor.userId,
        })
        .returning();
      await afterWrite?.(tx as Transaction);
      return row!;
    });
  }

  async findById(scope: ScopeContext, membershipId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select()
        .from(unitMemberships)
        .where(
          and(
            eq(unitMemberships.id, membershipId),
            this.scoped(scope, {
              unitId: unitMemberships.unitId,
              recordUserId: unitMemberships.userId,
            }),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  }

  /** Soft revoke: `status='REVOKED'`, `valid_to=now()`. The row is never deleted. */
  async revoke(
    scope: ScopeContext,
    membershipId: string,
    afterWrite?: (tx: Transaction) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(unitMemberships)
        .set({ status: 'REVOKED', validTo: sql`now()` })
        .where(
          and(
            eq(unitMemberships.id, membershipId),
            eq(unitMemberships.status, 'ACTIVE'),
            this.scoped(scope, {
              unitId: unitMemberships.unitId,
              recordUserId: unitMemberships.userId,
            }),
          ),
        )
        .returning();
      if (row) await afterWrite?.(tx as Transaction);
      return row ?? null;
    });
  }

  async list(scope: ScopeContext, query: ListMembershipsQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        query.userId ? eq(unitMemberships.userId, query.userId) : undefined,
        query.unitId ? eq(unitMemberships.unitId, query.unitId) : undefined,
        query.role ? eq(unitMemberships.role, query.role) : undefined,
        query.status ? eq(unitMemberships.status, query.status) : undefined,
        query.cursor ? gt(unitMemberships.id, query.cursor) : undefined,
      ];

      return tx
        .select({
          membership: unitMemberships,
          userFullName: users.fullName,
          userLoginId: users.loginId,
          unitName: units.name,
        })
        .from(unitMemberships)
        .innerJoin(users, eq(users.id, unitMemberships.userId))
        .innerJoin(units, eq(units.id, unitMemberships.unitId))
        .where(
          this.scoped(
            scope,
            { unitId: unitMemberships.unitId, recordUserId: unitMemberships.userId },
            ...filters,
          ),
        )
        .orderBy(asc(unitMemberships.id))
        .limit(query.limit + 1);
    });
  }
}
