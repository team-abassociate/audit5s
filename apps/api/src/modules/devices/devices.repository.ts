import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { deviceUsers, devices, refreshTokens, users, type Database, type Transaction } from '@audit5s/db';
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
 * Scope is `own_record` for the field roles and `organization` for a Super Admin. Since 0025
 * a phone is shared, so "own" means *on the phone's list* (`device_user`), not "signed in
 * on it last" — the resolver's predicate is applied to the list inside an EXISTS.
 */
const memberScopeColumns = { recordUserId: deviceUsers.userId };

const deviceColumns = {
  id: devices.id,
  userId: devices.userId,
  platform: devices.platform,
  model: devices.model,
  osVersion: devices.osVersion,
  appVersion: devices.appVersion,
  lastSeenAt: devices.lastSeenAt,
  lastSyncAt: devices.lastSyncAt,
  revokedAt: devices.revokedAt,
  createdAt: devices.createdAt,
  updatedAt: devices.updatedAt,
};

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
      const written = await tx
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
          // Only a phone this person is on. The service refuses anybody else before this.
          where: sql`EXISTS (SELECT 1 FROM device_user
                             WHERE device_user.device_id = ${devices.id}
                               AND device_user.user_id = ${scope.actor.userId}::uuid)`,
        })
        .returning({ id: devices.id });
      // Nothing came back: the id is somebody else's phone. Registering is not a way onto
      // a phone — signing in on it is — so nothing is written and the caller reads 404.
      if (written.length === 0) return;
      // A new phone's first person. Nothing is changed for somebody already on the list,
      // including a revoked place: that is restored by signing in, not by re-registering.
      await tx
        .insert(deviceUsers)
        .values({ deviceId: input.id, userId: scope.actor.userId })
        .onConflictDoNothing();
    });
  }


  async list(scope: ScopeContext, query: ListDevicesQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        // Every phone this person is on, not only the ones they signed in on last.
        query.userId
          ? sql`EXISTS (SELECT 1 FROM device_user
                        WHERE device_user.device_id = ${devices.id}
                          AND device_user.user_id = ${query.userId}::uuid)`
          : undefined,
        query.includeRevoked ? undefined : isNull(devices.revokedAt),
        query.cursor ? sql`${devices.id} > ${query.cursor}` : undefined,
      ];

      const rows = await tx
        .select(deviceColumns)
        .from(devices)
        .where(and(this.onTheList(scope), ...filters.filter((f): f is SQL => f !== undefined)))
        .orderBy(desc(devices.lastSeenAt), asc(devices.id))
        .limit(query.limit + 1);
      return this.withPeople(tx, rows);
    });
  }

  async findById(scope: ScopeContext, deviceId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const rows = await tx
        .select(deviceColumns)
        .from(devices)
        .where(and(eq(devices.id, deviceId), this.onTheList(scope)))
        .limit(1);
      const [row] = await this.withPeople(tx, rows);
      return row ?? null;
    });
  }

  /**
   * The resolver's predicate, asked of the phone's list rather than of the phone: a device
   * is in scope when somebody in scope is on it. Under `organization` that is every phone
   * with anybody on it, which since the 0025 backfill is every phone.
   */
  private onTheList(scope: ScopeContext): SQL {
    return sql`EXISTS (SELECT 1 FROM device_user
                       WHERE device_user.device_id = ${devices.id}
                         AND ${this.scoped(scope, memberScopeColumns)})`;
  }

  /** Everybody on each phone, newest sign-in first, for the Devices table. */
  private async withPeople<T extends { id: string }>(tx: Transaction, rows: T[]) {
    const ids = rows.map((row) => row.id);
    const people =
      ids.length === 0
        ? []
        : await tx
            .select({
              deviceId: deviceUsers.deviceId,
              userId: deviceUsers.userId,
              fullName: users.fullName,
              lastSignedInAt: deviceUsers.lastSignedInAt,
              revokedAt: deviceUsers.revokedAt,
            })
            .from(deviceUsers)
            .innerJoin(users, eq(users.id, deviceUsers.userId))
            .where(inArray(deviceUsers.deviceId, ids))
            .orderBy(desc(deviceUsers.lastSignedInAt));
    return rows.map((row) => ({
      ...row,
      people: people.filter((person) => person.deviceId === row.id),
    }));
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

  /**
   * One person off a shared phone: their place on its list and their sessions bound to
   * it. Everybody else on the phone carries on (0025).
   */
  async leave(scope: ScopeContext, deviceId: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(deviceUsers)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(deviceUsers.deviceId, deviceId),
            eq(deviceUsers.userId, userId),
            isNull(deviceUsers.revokedAt),
          ),
        );
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.deviceId, deviceId),
            eq(refreshTokens.userId, userId),
            isNull(refreshTokens.revokedAt),
          ),
        );
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
