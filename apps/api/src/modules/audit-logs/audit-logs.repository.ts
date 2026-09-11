import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt, lte, sql, type SQL } from 'drizzle-orm';
import { auditLogs, type Database } from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type { ListAuditLogQuery } from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

@Injectable()
export class AuditLogsRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  async list(scope: ScopeContext, query: ListAuditLogQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        query.action ? eq(auditLogs.action, query.action) : undefined,
        query.actorUserId ? eq(auditLogs.actorUserId, query.actorUserId) : undefined,
        query.resourceType ? eq(auditLogs.resourceType, query.resourceType) : undefined,
        query.resourceId ? eq(auditLogs.resourceId, query.resourceId) : undefined,
        query.unitId ? eq(auditLogs.unitId, query.unitId) : undefined,
        query.from ? gte(auditLogs.occurredAt, new Date(query.from)) : undefined,
        query.to ? lte(auditLogs.occurredAt, new Date(query.to)) : undefined,
        // The log is append-only and strictly ordered, so its own id is the cursor.
        query.cursor ? lt(auditLogs.id, BigInt(query.cursor)) : undefined,
      ];

      return tx
        .select()
        .from(auditLogs)
        .where(and(this.scoped(scope, { unitId: auditLogs.unitId }), ...filters.filter(Boolean)))
        .orderBy(desc(auditLogs.id))
        .limit(query.limit + 1);
    });
  }

  async countAll(scope: ScopeContext): Promise<number> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const result = await tx.execute(sql`SELECT count(*)::int AS n FROM audit_log`);
      const rows = (result as unknown as { rows: Array<{ n: number }> }).rows;
      return rows[0]?.n ?? 0;
    });
  }
}
