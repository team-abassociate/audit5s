import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { unitMemberships, users, revokedAccessTokens, type Database } from '@audit5s/db';
import type { ActorContext } from '@audit5s/domain';
import type { Role, UserStatus } from '@audit5s/contracts';
import { DATABASE } from '../../infrastructure/database/database.module';

export interface ActorRecord {
  actor: ActorContext;
  status: UserStatus;
  mustResetPassword: boolean;
  bootstrapExpiresAt: Date | null;
  archivedAt: Date | null;
  fullName: string;
  loginId: string;
}

/**
 * Resolves the actor and their scope from the database on **every** request.
 *
 * This is the deliberate cost of keeping permissions and unit IDs out of the access token
 * (§12.3): revoking a Unit assignment or disabling an account takes effect on the next
 * request rather than up to 15 minutes later.
 */
@Injectable()
export class ActorRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async loadActor(userId: string, deviceId: string | null): Promise<ActorRecord | null> {
    return this.db.transaction(async (tx) => {
      // The actor's own row and memberships are readable under their own context; RLS
      // takes it from here, so this cannot be turned into a lookup of somebody else.
      await tx.execute(sql`SELECT set_config('app.actor_id', ${userId}, true)`);
      await tx.execute(sql`SELECT set_config('app.auth_phase', 'on', true)`);

      const [user] = await tx
        .select({
          id: users.id,
          role: users.role,
          status: users.status,
          mustResetPassword: users.mustResetPassword,
          bootstrapExpiresAt: users.bootstrapExpiresAt,
          archivedAt: users.archivedAt,
          fullName: users.fullName,
          loginId: users.loginId,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!user) {
        return null;
      }

      const memberships = await tx
        .select({ unitId: unitMemberships.unitId, role: unitMemberships.role })
        .from(unitMemberships)
        .where(
          and(
            eq(unitMemberships.userId, userId),
            eq(unitMemberships.status, 'ACTIVE'),
            sql`now() >= ${unitMemberships.validFrom}`,
            sql`(${unitMemberships.validTo} IS NULL OR now() < ${unitMemberships.validTo})`,
          ),
        );

      const unitIds = memberships.map((m) => m.unitId);

      return {
        actor: {
          userId: user.id,
          role: user.role as Role,
          // M-1 guarantees a COORDINATOR or ZONE_LEADER has at most one, so [0] is not a
          // coin flip. A CONSULTANT holds many and uses `assigned_units` instead.
          activeUnitId:
            user.role === 'COORDINATOR' || user.role === 'ZONE_LEADER' ? (unitIds[0] ?? null) : null,
          unitIds,
          deviceId,
        },
        status: user.status as UserStatus,
        mustResetPassword: user.mustResetPassword,
        bootstrapExpiresAt: user.bootstrapExpiresAt,
        archivedAt: user.archivedAt,
        fullName: user.fullName,
        loginId: user.loginId,
      };
    });
  }

  /** Immediate access-token revocation (§12.3), in Postgres because there is no Redis. */
  async isAccessTokenRevoked(jti: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.auth_phase', 'on', true)`);
      const [row] = await tx
        .select({ jti: revokedAccessTokens.jti })
        .from(revokedAccessTokens)
        .where(eq(revokedAccessTokens.jti, jti))
        .limit(1);
      return row !== undefined;
    });
  }

  /** Sweeps denylist entries whose underlying token has expired anyway. */
  async sweepRevokedTokens(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.auth_phase', 'on', true)`);
      await tx.delete(revokedAccessTokens).where(sql`${revokedAccessTokens.expiresAt} < now()`);
    });
  }

  /** Guards against a user archived mid-session. */
  static isUsable(record: ActorRecord): boolean {
    return record.archivedAt === null && record.status === 'ACTIVE';
  }

  static notArchived() {
    return isNull(users.archivedAt);
  }
}
