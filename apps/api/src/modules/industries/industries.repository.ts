import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { industries, type Database } from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type { CreateIndustryRequest } from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

export type IndustryPatch = Partial<{
  name: string;
  description: string | null;
  sortOrder: number;
  archivedAt: Date | null;
}>;

/**
 * Industries (0018).
 *
 * No scope predicate on the reads, and that is not an oversight: `industry_select` admits
 * every signed-in actor, exactly as `checklist_template_select` does (D2). The list of
 * sectors carries no Unit-identifying data, and a Consultant must be able to read the
 * label on a catalogue they are already allowed to read. Writes are refused by
 * `industry_insert` / `industry_update` for anyone but a Super Admin, in the database, not
 * only in the guard chain.
 */
@Injectable()
export class IndustriesRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  /**
   * The counts come from correlated subqueries rather than two group-bys joined in.
   * At the scale this list runs at — a handful of sectors — one query that reads plainly
   * beats a faster one that does not, and the screen needs both numbers on every row to
   * tell someone whether archiving an industry would strand anything.
   */
  async list(scope: ScopeContext, includeArchived: boolean) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({
          id: industries.id,
          code: industries.code,
          name: industries.name,
          description: industries.description,
          sortOrder: industries.sortOrder,
          archivedAt: industries.archivedAt,
          createdAt: industries.createdAt,
          updatedAt: industries.updatedAt,
          templateCount: sql<number>`(
            SELECT count(*)::int FROM checklist_template t
             WHERE t.industry_id = ${industries.id} AND t.archived_at IS NULL
          )`,
          unitCount: sql<number>`(
            SELECT count(*)::int FROM unit u
             WHERE u.industry_id = ${industries.id} AND u.archived_at IS NULL
          )`,
        })
        .from(industries)
        .where(includeArchived ? undefined : isNull(industries.archivedAt))
        .orderBy(asc(industries.sortOrder), asc(industries.name));
    });
  }

  async findById(scope: ScopeContext, industryId: string) {
    const rows = await this.list(scope, true);
    return rows.find((row) => row.id === industryId) ?? null;
  }

  async create(scope: ScopeContext, request: CreateIndustryRequest) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .insert(industries)
        .values({
          code: request.code,
          name: request.name,
          description: request.description ?? null,
          ...(request.sortOrder !== undefined ? { sortOrder: request.sortOrder } : {}),
        })
        .returning();
      return row!;
    });
  }

  async update(scope: ScopeContext, industryId: string, patch: IndustryPatch) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(industries)
        .set(patch)
        .where(and(eq(industries.id, industryId), isNull(industries.archivedAt)))
        .returning();
      return row ?? null;
    });
  }
}
