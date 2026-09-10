import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { auditLogs, type Database } from '@audit5s/db';
import { DATABASE } from '../../infrastructure/database/database.module';

export interface AuditLogRow {
  actorUserId: string | null;
  actorRole: 'SUPER_ADMIN' | 'CONSULTANT' | 'COORDINATOR' | 'ZONE_LEADER' | null;
  actorLabel: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  unitId: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  deviceId: string | null;
  requestId: string;
}

/**
 * Writes to `audit_log`.
 *
 * No scope predicate: this is an insert-only table whose RLS policy admits any
 * authenticated actor, because the interceptor writes *as* the actor whose action it
 * records. It still lives in a repository so the AZ-1 boundary — queries belong to
 * repositories — holds everywhere rather than "everywhere except the convenient places".
 */
@Injectable()
export class AuditLogRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(row: AuditLogRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (row.actorUserId && row.actorRole) {
        await tx.execute(sql`SELECT set_config('app.actor_id', ${row.actorUserId}, true)`);
        await tx.execute(sql`SELECT set_config('app.actor_role', ${row.actorRole}, true)`);
      } else {
        await tx.execute(sql`SELECT set_config('app.auth_phase', 'on', true)`);
      }

      await tx.insert(auditLogs).values({
        actorUserId: row.actorUserId,
        actorRole: row.actorRole,
        actorLabel: row.actorLabel,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        unitId: row.unitId,
        before: row.before as never,
        after: row.after as never,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        deviceId: row.deviceId,
        requestId: row.requestId,
      });
    });
  }
}
