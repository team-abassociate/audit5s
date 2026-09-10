import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { permissions, rolePermissions, type Database } from '@audit5s/db';
import { DATABASE } from '../../infrastructure/database/database.module';

/**
 * Reads the seeded permission matrix.
 *
 * `permission` and `role_permission` are organization-wide reference data with no
 * Unit-identifying content, so there is no scope predicate to apply — the RLS policy
 * requires an authenticated actor and PART 6 gates the route to SUPER_ADMIN.
 */
@Injectable()
export class PermissionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listWithGrants(actorId: string, actorRole: string) {
    return this.db.transaction(async (tx) => {
      // The RLS policy on the reference tables requires an authenticated actor.
      await tx.execute(sql`SELECT set_config('app.actor_id', ${actorId}, true)`);
      await tx.execute(sql`SELECT set_config('app.actor_role', ${actorRole}, true)`);

      return tx
        .select({
          resource: permissions.resource,
          action: permissions.action,
          description: permissions.description,
          role: rolePermissions.role,
          scopeRule: rolePermissions.scopeRule,
          condition: rolePermissions.condition,
        })
        .from(permissions)
        .leftJoin(rolePermissions, eq(rolePermissions.permissionId, permissions.id))
        .orderBy(asc(permissions.resource), asc(permissions.action));
    });
  }
}
