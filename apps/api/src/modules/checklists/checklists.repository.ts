import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  checklistQuestions,
  checklistTemplates,
  checklistVersions,
  type Database,
  type Transaction,
} from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import type {
  ListChecklistTemplatesQuery,
  ListChecklistVersionsQuery,
} from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

/**
 * Checklists are organization-wide reference data (D2), so every grant in PART 6 is the
 * `organization` resolver — the predicate `TRUE`.
 *
 * That does **not** make the scope argument ceremonial. AZ-4 is explicit that SUPER_ADMIN
 * is not a bypass flag and AZ-1 that no repository method runs without a predicate: these
 * queries are built through `scoped()` like every other, so there is no second shape of
 * query in the codebase for anyone to copy when the data is not organization-wide.
 */
/** The template's currently published version, joined for the catalogue. */
const published = alias(checklistVersions, 'published_version');

@Injectable()
export class ChecklistsRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  /** `organization` needs no column; the predicate is `TRUE`. */
  private everything(scope: ScopeContext, ...filters: Array<SQL | undefined>): SQL {
    return this.scoped(scope, {}, ...filters);
  }

  async listTemplates(scope: ScopeContext, query: ListChecklistTemplatesQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({
          id: checklistTemplates.id,
          code: checklistTemplates.code,
          name: checklistTemplates.name,
          description: checklistTemplates.description,
          isActive: checklistTemplates.isActive,
          industryId: checklistTemplates.industryId,
          // Through a scalar subquery rather than a join: `industry` is readable by every
          // signed-in actor (0018), and a join would change the row shape of two queries
          // that several callers already destructure.
          industryName: sql<string | null>`(SELECT i.name FROM industry i WHERE i.id = ${checklistTemplates.industryId})`,
          sortOrder: checklistTemplates.sortOrder,
          archivedAt: checklistTemplates.archivedAt,
          createdAt: checklistTemplates.createdAt,
          updatedAt: checklistTemplates.updatedAt,
          publishedVersionId: published.id,
          publishedVersionNumber: published.versionNumber,
        })
        .from(checklistTemplates)
        // At most one published version per template, so the join cannot fan out — that
        // is the `UNIQUE(template_id) WHERE status='PUBLISHED'` index doing double duty.
        .leftJoin(
          published,
          and(eq(published.templateId, checklistTemplates.id), eq(published.status, 'PUBLISHED')),
        )
        .where(
          this.everything(
            scope,
            query.includeArchived ? undefined : isNull(checklistTemplates.archivedAt),
            // Unclassified templates come through every filter (0018): NULL means "offered
            // everywhere", so narrowing to Hospital must not hide a template nobody has
            // labelled yet — which, on the day a second sector is added, is all of them.
            query.industryId
              ? sql`(${checklistTemplates.industryId} = ${query.industryId} OR ${checklistTemplates.industryId} IS NULL)`
              : undefined,
            query.cursor ? gt(checklistTemplates.id, query.cursor) : undefined,
          ),
        )
        .orderBy(asc(checklistTemplates.sortOrder), asc(checklistTemplates.name))
        .limit(query.limit + 1);
    });
  }

  async findTemplateById(scope: ScopeContext, templateId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: checklistTemplates.id,
          code: checklistTemplates.code,
          name: checklistTemplates.name,
          description: checklistTemplates.description,
          isActive: checklistTemplates.isActive,
          industryId: checklistTemplates.industryId,
          // Through a scalar subquery rather than a join: `industry` is readable by every
          // signed-in actor (0018), and a join would change the row shape of two queries
          // that several callers already destructure.
          industryName: sql<string | null>`(SELECT i.name FROM industry i WHERE i.id = ${checklistTemplates.industryId})`,
          sortOrder: checklistTemplates.sortOrder,
          archivedAt: checklistTemplates.archivedAt,
          createdAt: checklistTemplates.createdAt,
          updatedAt: checklistTemplates.updatedAt,
          publishedVersionId: published.id,
          publishedVersionNumber: published.versionNumber,
        })
        .from(checklistTemplates)
        // At most one published version per template, so the join cannot fan out — that
        // is the `UNIQUE(template_id) WHERE status='PUBLISHED'` index doing double duty.
        .leftJoin(
          published,
          and(eq(published.templateId, checklistTemplates.id), eq(published.status, 'PUBLISHED')),
        )
        .where(and(eq(checklistTemplates.id, templateId), this.everything(scope)))
        .limit(1);
      return row ?? null;
    });
  }

  async updateTemplate(
    scope: ScopeContext,
    templateId: string,
    patch: Partial<{ name: string; description: string | null; sortOrder: number; isActive: boolean }>,
  ) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(checklistTemplates)
        .set(patch)
        .where(and(eq(checklistTemplates.id, templateId), this.everything(scope)))
        .returning({ id: checklistTemplates.id });
      return row?.id ?? null;
    });
  }

  async listVersions(scope: ScopeContext, query: ListChecklistVersionsQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select(versionColumns)
        .from(checklistVersions)
        .innerJoin(checklistTemplates, eq(checklistTemplates.id, checklistVersions.templateId))
        .where(
          this.everything(
            scope,
            query.status ? eq(checklistVersions.status, query.status) : undefined,
            query.templateId ? eq(checklistVersions.templateId, query.templateId) : undefined,
            query.cursor ? gt(checklistVersions.id, query.cursor) : undefined,
          ),
        )
        .orderBy(asc(checklistTemplates.sortOrder), desc(checklistVersions.versionNumber))
        .limit(query.limit + 1);
    });
  }

  async findVersionById(scope: ScopeContext, versionId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select(versionColumns)
        .from(checklistVersions)
        .innerJoin(checklistTemplates, eq(checklistTemplates.id, checklistVersions.templateId))
        .where(and(eq(checklistVersions.id, versionId), this.everything(scope)))
        .limit(1);
      return row ?? null;
    });
  }

  async listQuestions(scope: ScopeContext, versionIds: string[]) {
    if (versionIds.length === 0) return [];
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select()
        .from(checklistQuestions)
        .where(this.everything(scope, inArray(checklistQuestions.versionId, versionIds)))
        .orderBy(asc(checklistQuestions.versionId), asc(checklistQuestions.globalOrder));
    });
  }

  /** Every PUBLISHED version, with its questions — the mobile catalogue source. */
  async listPublishedVersions(scope: ScopeContext) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select(versionColumns)
        .from(checklistVersions)
        .innerJoin(checklistTemplates, eq(checklistTemplates.id, checklistVersions.templateId))
        .where(this.everything(scope, eq(checklistVersions.status, 'PUBLISHED')))
        .orderBy(asc(checklistTemplates.sortOrder));
    });
  }

  /**
   * `DRAFT → PUBLISHED`, superseding whatever this template had published.
   *
   * One transaction, and the order matters: the previous version is retired before the
   * new one is published, because `UNIQUE(template_id) WHERE status='PUBLISHED'` would
   * otherwise refuse the second statement. The database enforcing "at most one" is
   * exactly why this cannot be done in two round trips.
   */
  async publish(
    scope: ScopeContext,
    versionId: string,
    publishedByUserId: string,
    afterWrite?: (tx: Transaction) => Promise<void>,
  ) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const [version] = await tx
        .select({
          id: checklistVersions.id,
          templateId: checklistVersions.templateId,
          status: checklistVersions.status,
        })
        .from(checklistVersions)
        .where(and(eq(checklistVersions.id, versionId), this.everything(scope)))
        .limit(1);

      if (!version) return { outcome: 'NOT_FOUND' as const };
      if (version.status !== 'DRAFT') return { outcome: 'NOT_DRAFT' as const, status: version.status };

      const [previous] = await tx
        .select({ id: checklistVersions.id })
        .from(checklistVersions)
        .where(
          and(
            eq(checklistVersions.templateId, version.templateId),
            eq(checklistVersions.status, 'PUBLISHED'),
          ),
        )
        .limit(1);

      if (previous) {
        await tx
          .update(checklistVersions)
          .set({
            status: 'SUPERSEDED',
            supersededAt: sql`now()`,
            supersededByVersionId: versionId,
          })
          .where(eq(checklistVersions.id, previous.id));
      }

      await tx
        .update(checklistVersions)
        .set({ status: 'PUBLISHED', publishedAt: sql`now()`, publishedByUserId })
        .where(eq(checklistVersions.id, versionId));

      await afterWrite?.(tx as Transaction);

      return { outcome: 'PUBLISHED' as const, supersededVersionId: previous?.id ?? null };
    });
  }

  /**
   * `PUBLISHED → ARCHIVED`. In-flight audits keep their pinned version — deactivation
   * only stops the template being chosen for a new one.
   */
  async deactivate(scope: ScopeContext, versionId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .update(checklistVersions)
        .set({ status: 'ARCHIVED' })
        .where(
          and(
            eq(checklistVersions.id, versionId),
            eq(checklistVersions.status, 'PUBLISHED'),
            this.everything(scope),
          ),
        )
        .returning({ id: checklistVersions.id, templateId: checklistVersions.templateId });
      return row ?? null;
    });
  }
}

const versionColumns = {
  id: checklistVersions.id,
  templateId: checklistVersions.templateId,
  templateCode: checklistTemplates.code,
  templateName: checklistTemplates.name,
  versionNumber: checklistVersions.versionNumber,
  status: checklistVersions.status,
  questionsPerSection: checklistVersions.questionsPerSection,
  totalQuestions: checklistVersions.totalQuestions,
  publishedAt: checklistVersions.publishedAt,
  publishedByUserId: checklistVersions.publishedByUserId,
  supersededAt: checklistVersions.supersededAt,
  supersededByVersionId: checklistVersions.supersededByVersionId,
  sourceImportJobId: checklistVersions.sourceImportJobId,
  contentHash: checklistVersions.contentHash,
  createdAt: checklistVersions.createdAt,
};

export type ChecklistVersionRow = NonNullable<
  Awaited<ReturnType<ChecklistsRepository['findVersionById']>>
>;
export type ChecklistQuestionRow = Awaited<
  ReturnType<ChecklistsRepository['listQuestions']>
>[number];
export type ChecklistTemplateRow = NonNullable<
  Awaited<ReturnType<ChecklistsRepository['findTemplateById']>>
>;
export type { Transaction };
