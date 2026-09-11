import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { and, asc, eq, gt, ilike, isNull, sql, type SQL } from 'drizzle-orm';
import { unitMemberships, users, type Database, type Transaction } from '@audit5s/db';
import { LOGIN_ID_MAX_ATTEMPTS, loginIdCandidate, type ScopeContext } from '@audit5s/domain';
import type { ListUsersQuery, Role, UserStatus } from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { AppError } from '../../common/errors';
import { isUniqueViolation } from '../../common/pg-errors';

export interface CreateUserInput {
  fullName: string;
  phoneE164: string;
  email: string | null;
  role: Role;
  passwordHash: string;
  bootstrapExpiresAt: Date;
  createdByUserId: string;
  /** Needed by the RLS insert policy, which checks the actor's role. */
  createdByRole: string;
  unitId: string | null;
  assignedByUserId: string;
}

@Injectable()
export class UsersRepository extends BaseRepository {
  constructor(
    @Inject(DATABASE) db: Database,
    resolvers: ScopeResolverRegistry,
  ) {
    super(db, resolvers);
  }

  /**
   * Creates the user, allocates its login ID and (when a Unit is given) its membership,
   * all in one transaction.
   *
   * The allocation loop is the interesting part. Candidates are deterministic
   * ("RA3210", "RA3210-2", …) and there is **no read-then-write race**: each attempt just
   * INSERTs and lets `UNIQUE(login_id)` arbitrate. A collision is caught, the savepoint is
   * rolled back, and the next candidate is tried — up to 50, then it fails loudly rather
   * than inventing an identifier outside the scheme.
   *
   * The savepoint matters: in PostgreSQL a constraint violation aborts the surrounding
   * transaction, so without one the second attempt could not run.
   */
  async createWithLoginId(input: CreateUserInput): Promise<{ userId: string; loginId: string }> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, input.createdByUserId, input.createdByRole);

      for (let attempt = 0; attempt < LOGIN_ID_MAX_ATTEMPTS; attempt += 1) {
        const candidate = loginIdCandidate(input.fullName, input.phoneE164, attempt);

        // The id is minted here rather than read back with RETURNING. That is not a
        // micro-optimisation: `INSERT ... RETURNING` additionally requires the SELECT
        // policy to admit the new row, and a Coordinator creating a Zone Leader cannot yet
        // see them — the membership that brings the user into their scope is inserted on
        // the next statement. Generating the id keeps the read policy tight instead of
        // widening it to make a write convenient. UUIDv7 is what §5 specifies for
        // server-generated keys anyway: time-ordered, so index locality is preserved.
        const userId = uuidv7();

        try {
          await tx.transaction(async (savepoint) => {
            await savepoint.insert(users).values({
              id: userId,
              loginId: candidate,
              fullName: input.fullName,
              phoneE164: input.phoneE164,
              email: input.email,
              role: input.role,
              passwordHash: input.passwordHash,
              mustResetPassword: true,
              bootstrapExpiresAt: input.bootstrapExpiresAt,
              status: 'INVITED',
              createdByUserId: input.createdByUserId,
            });
          });

          if (input.unitId) {
            await tx.insert(unitMemberships).values({
              userId,
              unitId: input.unitId,
              role: input.role,
              assignedByUserId: input.assignedByUserId,
            });
          }

          return { userId, loginId: candidate };
        } catch (error) {
          if (!isUniqueViolation(error, 'user_login_id_key')) {
            throw error;
          }
          // Someone else took this candidate. Try the next one.
        }
      }

      throw new AppError(
        'LOGIN_ID_ALLOCATION_FAILED',
        500,
        'Could not allocate a login ID',
        `Exhausted ${LOGIN_ID_MAX_ATTEMPTS} candidates for this name and phone number`,
      );
    });
  }

  async findById(scope: ScopeContext, userId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.archivedAt), this.userScope(scope)))
        .limit(1);
      return row ?? null;
    });
  }

  async list(scope: ScopeContext, query: ListUsersQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        isNull(users.archivedAt),
        query.role ? eq(users.role, query.role) : undefined,
        query.status ? eq(users.status, query.status as UserStatus) : undefined,
        query.search ? ilike(users.fullName, `%${query.search}%`) : undefined,
        query.cursor ? gt(users.id, query.cursor) : undefined,
      ];

      return tx
        .select()
        .from(users)
        .where(and(this.userScope(scope, query.unitId), ...filters.filter(Boolean)))
        .orderBy(asc(users.id))
        .limit(query.limit + 1);
    });
  }

  async update(
    scope: ScopeContext,
    userId: string,
    patch: { fullName?: string; email?: string | null; phoneE164?: string },
  ) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(users)
        .set(patch)
        .where(and(eq(users.id, userId), isNull(users.archivedAt), this.userScope(scope)))
        .returning();
      return row ?? null;
    });
  }

  async disable(scope: ScopeContext, userId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(users)
        .set({ status: 'DISABLED' })
        .where(and(eq(users.id, userId), isNull(users.archivedAt), this.userScope(scope)))
        .returning();
      return row ?? null;
    });
  }

  async setBootstrapCredential(
    scope: ScopeContext,
    userId: string,
    passwordHash: string,
    bootstrapExpiresAt: Date,
  ) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(users)
        .set({
          passwordHash,
          mustResetPassword: true,
          bootstrapExpiresAt,
          failedLoginCount: 0,
          lockedUntil: null,
          status: 'INVITED',
        })
        .where(and(eq(users.id, userId), isNull(users.archivedAt), this.userScope(scope)))
        .returning();
      return row ?? null;
    });
  }

  /**
   * The scope predicate for `user`.
   *
   * `user` has no `unit_id` of its own — a user reaches a Unit through `unit_membership` —
   * so a Unit-shaped resolver becomes an EXISTS over that table. Any `unitId` the caller
   * supplied is intersected here, never substituted for the actor's own scope (AZ-2).
   */
  private userScope(scope: ScopeContext, filterUnitId?: string): SQL {
    const membershipFilter = (unitPredicate: SQL): SQL => sql`EXISTS (
      SELECT 1 FROM unit_membership m
      WHERE m.user_id = ${users.id}
        AND m.status = 'ACTIVE'
        AND ${unitPredicate}
        ${filterUnitId ? sql`AND m.unit_id = ${filterUnitId}` : sql``}
    )`;

    switch (scope.resolver) {
      case 'organization':
        return filterUnitId ? membershipFilter(sql`true`) : sql`true`;
      case 'own_record':
        return eq(users.id, scope.actor.userId);
      case 'own_unit':
        if (!scope.actor.activeUnitId) return sql`false`;
        return membershipFilter(sql`m.unit_id = ${scope.actor.activeUnitId}`);
      case 'assigned_units':
        if (scope.actor.unitIds.length === 0) return sql`false`;
        // Bound as a single array parameter — never string-built, per §12.15.
        return membershipFilter(sql`m.unit_id = ANY(${scope.actor.unitIds}::uuid[])`);
      default:
        // An unmapped resolver must never fall through to "everything".
        return sql`false`;
    }
  }
}

/** Sets the RLS actor context for this transaction. */
export async function setActorContext(
  tx: Transaction,
  actorId: string,
  actorRole?: string,
): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.actor_id', ${actorId}, true)`);
  if (actorRole) {
    await tx.execute(sql`SELECT set_config('app.actor_role', ${actorRole}, true)`);
  }
}


