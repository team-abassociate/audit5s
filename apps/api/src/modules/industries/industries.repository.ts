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
   * The list, with how many templates and Units point at each row.
   *
   * Three plain queries rather than correlated subqueries inside the projection. The
   * subquery version returned 0 for every row — a correlation that reads correctly and
   * does not bind is the kind of bug that looks like missing data, and it cost a CI round
   * to find. Two grouped counts and a join in memory cannot be wrong that way, and at a
   * handful of sectors the difference is unmeasurable.
   *
   * Both counts ignore archived rows: an archived template is not a reason to keep a
   * sector alive.
   */
  async list(scope: ScopeContext, includeArchived: boolean) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const rows = await tx
        .select()
        .from(industries)
        .where(includeArchived ? undefined : isNull(industries.archivedAt))
        .orderBy(asc(industries.sortOrder), asc(industries.name));

      const templates = await tx.execute(sql`
        SELECT industry_id, count(*)::int AS n
          FROM checklist_template
         WHERE industry_id IS NOT NULL AND archived_at IS NULL
         GROUP BY industry_id
      `);
      const units = await tx.execute(sql`
        SELECT industry_id, count(*)::int AS n
          FROM unit
         WHERE industry_id IS NOT NULL AND archived_at IS NULL
         GROUP BY industry_id
      `);

      const tally = (result: { rows: unknown[] }): Map<string, number> =>
        new Map(
          (result.rows as Array<{ industry_id: string; n: number }>).map((row) => [
            row.industry_id,
            Number(row.n),
          ]),
        );
      const byTemplate = tally(templates);
      const byUnit = tally(units);

      return rows.map((row) => ({
        ...row,
        templateCount: byTemplate.get(row.id) ?? 0,
        unitCount: byUnit.get(row.id) ?? 0,
      }));
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
