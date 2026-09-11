import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { devices, refreshTokens, users, type Database } from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type { ListDevicesQuery } from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

/**
 * Devices (§5.2, §8.11).
 *
 * A device row has existed since Phase 1 — `auth/login` upserts one as a side effect —
 * but PART 6 granted `device:list` and `device:revoke` with no routes behind them, so
 * neither could be exercised. Phase 4 adds `POST /devices/register` (§8.11) and the two
 * read/revoke routes those grants were always for.
 *
 * Scope is `own_record` for the field roles and `organization` for a Super Admin, which
 * both resolve against `device.user_id` — the device *is* a personal record.
 */
const deviceScopeColumns = { recordUserId: devices.userId };

@Injectable()
export class DevicesRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  /**
   * `POST /devices/register` — idempotent on `id` (§8.11).
   *
   * The same statement the login path uses, so a device that registers explicitly and one
   * that appears at sign-in are the same row with the same history. `revokedAt` is
   * deliberately **not** cleared: re-registering a revoked device must not un-revoke it,
   * or revocation would be one app restart away from meaningless.
   */
  async register(
    scope: ScopeContext,
    input: {
      id: string;
      platform: string;
      model: string | null;
      osVersion: string | null;
      appVersion: string | null;
      pushToken: string | null;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .insert(devices)
        .values({
          id: input.id,
          userId: scope.actor.userId,
          platform: input.platform,
          model: input.model,
          osVersion: input.osVersion,
          appVersion: input.appVersion,
          pushToken: input.pushToken,
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: devices.id,
          set: {
            platform: input.platform,
            model: input.model,
            osVersion: input.osVersion,
            appVersion: input.appVersion,
            ...(input.pushToken ? { pushToken: input.pushToken } : {}),
            lastSeenAt: new Date(),
          },
          // Only the owner's own row. A device id belonging to somebody else is not
          // reassigned by whoever guesses it.
          where: eq(devices.userId, scope.actor.userId),
        });
    });
  }

  async list(scope: ScopeContext, query: ListDevicesQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        query.userId ? eq(devices.userId, query.userId) : undefined,
        query.includeRevoked ? undefined : isNull(devices.revokedAt),
        query.cursor ? sql`${devices.id} > ${query.cursor}` : undefined,
      ];

      return tx
        .select({
          id: devices.id,
          userId: devices.userId,
          userName: users.fullName,
          platform: devices.platform,
          model: devices.model,
          osVersion: devices.osVersion,
          appVersion: devices.appVersion,
          lastSeenAt: devices.lastSeenAt,
          lastSyncAt: devices.lastSyncAt,
          revokedAt: devices.revokedAt,
          createdAt: devices.createdAt,
          updatedAt: devices.updatedAt,
        })
        .from(devices)
        .innerJoin(users, eq(users.id, devices.userId))
        .where(this.scoped(scope, deviceScopeColumns, ...filters))
        .orderBy(desc(devices.lastSeenAt), asc(devices.id))
        .limit(query.limit + 1);
    });
  }

  async findById(scope: ScopeContext, deviceId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: devices.id,
          userId: devices.userId,
          userName: users.fullName,
          platform: devices.platform,
          model: devices.model,
          osVersion: devices.osVersion,
          appVersion: devices.appVersion,
          lastSeenAt: devices.lastSeenAt,
          lastSyncAt: devices.lastSyncAt,
          revokedAt: devices.revokedAt,
          createdAt: devices.createdAt,
          updatedAt: devices.updatedAt,
        })
        .from(devices)
        .innerJoin(users, eq(users.id, devices.userId))
        .where(and(eq(devices.id, deviceId), this.scoped(scope, deviceScopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * Revokes a device and the sessions bound to it, in one transaction.
   *
   * Both halves matter. Revoking the row alone leaves a valid refresh token that would
   * mint fresh access tokens for a phone somebody has just reported lost; revoking the
   * tokens alone lets the next login quietly re-register it.
   */
  async revoke(scope: ScopeContext, deviceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, deviceId));
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.deviceId, deviceId), isNull(refreshTokens.revokedAt)));
    });
  }

  /** Stamps the device's last successful sync, for the dashboard's staleness column. */
  async touchSync(scope: ScopeContext, deviceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(devices)
        .set({ lastSyncAt: new Date(), lastSeenAt: new Date() })
        .where(eq(devices.id, deviceId));
    });
  }
}

export type DeviceRow = NonNullable<Awaited<ReturnType<DevicesRepository['findById']>>>;
