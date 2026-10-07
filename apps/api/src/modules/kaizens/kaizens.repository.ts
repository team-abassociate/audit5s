import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import {
  kaizenPhotos,
  kaizenReviews,
  kaizens,
  units,
  zones,
  type Database,
  type Transaction,
} from '@audit5s/db';
import type { KaizenFields, KaizenReviewDecision, ListKaizensQuery } from '@audit5s/contracts';
import type { KaizenFact, ScopeContext } from '@audit5s/domain';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

/**
 * Kaizens (R-48, plans/kaizen-module.md §4.5).
 *
 * Every resolver PART 6 names for `kaizen:*` has its column: `own_unit` and
 * `assigned_units` the Kaizen's Unit, `own_record` its author — a Zone Leader's Kaizens are
 * theirs alone (owner, 2026-10-07). 0044's policies say the same in SQL.
 */
const scopeColumns = { unitId: kaizens.unitId, recordUserId: kaizens.authorUserId };

const rowColumns = {
  kaizen: kaizens,
  unitName: units.name,
  zoneCode: zones.code,
  zoneName: zones.name,
  department: zones.departmentHint,
};

export type KaizenRow = typeof kaizens.$inferSelect & {
  unitName: string;
  zoneCode: string;
  zoneName: string;
  department: string | null;
};
export type KaizenReviewRow = typeof kaizenReviews.$inferSelect;
export type KaizenPhotoRow = typeof kaizenPhotos.$inferSelect;

/** What a writer sends, as columns. `undefined` leaves a column as it is. */
export type KaizenColumns = Partial<typeof kaizens.$inferInsert>;

export function kaizenColumnsOf(fields: KaizenFields): KaizenColumns {
  const { annualSaving, ...rest } = fields;
  return {
    ...rest,
    ...(annualSaving !== undefined
      ? { annualSaving: annualSaving === null ? null : annualSaving.toFixed(2) }
      : {}),
  };
}

@Injectable()
export class KaizensRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  /** One transaction as the actor, so RLS sees who is asking. */
  inTransaction<T>(scope: ScopeContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return work(tx as Transaction);
    });
  }

  // ---------------------------------------------------------------------- reads

  async findById(scope: ScopeContext, kaizenId: string, tx?: Transaction): Promise<KaizenRow | null> {
    const run = async (t: Transaction) => {
      const [row] = await this.select(t)
        .where(this.scoped(scope, scopeColumns, eq(kaizens.id, kaizenId)))
        .limit(1);
      return row ? flatten(row) : null;
    };
    return tx ? run(tx) : this.inTransaction(scope, run);
  }

  async list(scope: ScopeContext, query: ListKaizensQuery): Promise<KaizenRow[]> {
    return this.inTransaction(scope, async (tx) => {
      const bySaving = query.sort === 'saving';
      const filters: Array<SQL | undefined> = [
        query.unitId ? eq(kaizens.unitId, query.unitId) : undefined,
        query.zoneId ? eq(kaizens.zoneId, query.zoneId) : undefined,
        query.status ? eq(kaizens.status, query.status) : undefined,
        query.mine ? eq(kaizens.authorUserId, scope.actor.userId) : undefined,
        query.submittedFrom ? gte(kaizens.submittedAt, new Date(query.submittedFrom)) : undefined,
        // Ids are UUIDv7, so id order is creation order and the cursor is the last id.
        !bySaving && query.cursor ? lt(kaizens.id, query.cursor) : undefined,
      ];
      const rows = await this.select(tx)
        .where(this.scoped(scope, scopeColumns, ...filters))
        .orderBy(
          // ponytail: `saving` is the Top 3 and is one page, no cursor. Page it when a
          // screen lists every Kaizen by saving.
          ...(bySaving ? [sql`${kaizens.annualSaving} DESC NULLS LAST`] : []),
          desc(kaizens.id),
        )
        .limit(query.limit + 1);
      return rows.map(flatten);
    });
  }

  /** Reviews of these Kaizens, oldest first. RLS shows them exactly when the Kaizen is visible. */
  async reviewsFor(scope: ScopeContext, kaizenIds: string[], tx?: Transaction): Promise<KaizenReviewRow[]> {
    if (kaizenIds.length === 0) return [];
    const run = (t: Transaction) =>
      t
        .select()
        .from(kaizenReviews)
        .innerJoin(kaizens, eq(kaizens.id, kaizenReviews.kaizenId))
        .where(this.scoped(scope, scopeColumns, inArray(kaizenReviews.kaizenId, kaizenIds)))
        .orderBy(asc(kaizenReviews.createdAt), asc(kaizenReviews.id))
        .then((rows) => rows.map((row) => row.kaizen_review));
    return tx ? run(tx) : this.inTransaction(scope, run);
  }

  /** The live (not removed) photos of these Kaizens. */
  async photosFor(scope: ScopeContext, kaizenIds: string[], tx?: Transaction): Promise<KaizenPhotoRow[]> {
    if (kaizenIds.length === 0) return [];
    const run = (t: Transaction) =>
      t
        .select()
        .from(kaizenPhotos)
        .innerJoin(kaizens, eq(kaizens.id, kaizenPhotos.kaizenId))
        .where(
          this.scoped(
            scope,
            scopeColumns,
            inArray(kaizenPhotos.kaizenId, kaizenIds),
            isNull(kaizenPhotos.deletedAt),
          ),
        )
        .then((rows) => rows.map((row) => row.kaizen_photo));
    return tx ? run(tx) : this.inTransaction(scope, run);
  }

  async findPhoto(scope: ScopeContext, photoId: string): Promise<KaizenPhotoRow | null> {
    return this.inTransaction(scope, async (tx) => {
      const [row] = await tx
        .select()
        .from(kaizenPhotos)
        .innerJoin(kaizens, eq(kaizens.id, kaizenPhotos.kaizenId))
        .where(this.scoped(scope, scopeColumns, eq(kaizenPhotos.id, photoId)))
        .limit(1);
      return row?.kaizen_photo ?? null;
    });
  }

  /**
   * The dashboard's facts: one row per counted Kaizen in scope, nothing more. DRAFT is
   * left out here as well as in the counting rules — it is most of a busy Unit's rows.
   */
  async facts(scope: ScopeContext, unitId: string | undefined): Promise<KaizenFact[]> {
    return this.inTransaction(scope, async (tx) => {
      const rows = await tx
        .select({
          status: kaizens.status,
          submittedAt: kaizens.submittedAt,
          approvedAt: sql<Date | string | null>`(SELECT max(r.created_at) FROM kaizen_review r
            WHERE r.kaizen_id = ${kaizens.id} AND r.decision = 'APPROVED')`,
          reviewed: sql<boolean>`EXISTS (SELECT 1 FROM kaizen_review r WHERE r.kaizen_id = ${kaizens.id})`,
          annualSaving: kaizens.annualSaving,
          department: zones.departmentHint,
          zoneId: kaizens.zoneId,
          zoneName: zones.name,
          zoneCode: zones.code,
        })
        .from(kaizens)
        .innerJoin(zones, eq(zones.id, kaizens.zoneId))
        .where(
          this.scoped(
            scope,
            scopeColumns,
            sql`${kaizens.status} <> 'DRAFT'`,
            unitId ? eq(kaizens.unitId, unitId) : undefined,
          ),
        );
      return rows.map((row) => ({
        ...row,
        submittedAt: row.submittedAt?.toISOString() ?? null,
        approvedAt: row.approvedAt ? new Date(row.approvedAt).toISOString() : null,
        annualSaving: row.annualSaving === null ? null : Number(row.annualSaving),
      }));
    });
  }

  /**
   * The Zone a new Kaizen is filed under, if the actor may file in it: active, and inside
   * the scope `kaizen:create` grants them (their own Unit). Out of scope reads as absent.
   */
  async zoneForCreate(scope: ScopeContext, zoneId: string, tx: Transaction) {
    const [zone] = await tx
      .select({ id: zones.id, unitId: zones.unitId })
      .from(zones)
      .where(this.scoped(scope, { unitId: zones.unitId }, eq(zones.id, zoneId), isNull(zones.archivedAt)))
      .limit(1);
    return zone ?? null;
  }

  // --------------------------------------------------------------------- writes

  /** The DRAFT, numbered by 0044's trigger. Unit and author come from the server, never the body. */
  async insert(
    tx: Transaction,
    scope: ScopeContext,
    values: { id: string; zoneId: string; unitId: string } & KaizenColumns,
  ): Promise<void> {
    await tx.insert(kaizens).values({
      ...values,
      authorUserId: scope.actor.userId,
      // Snapshotted (R-14(e)); the actor may always read their own user row.
      authorName: sql`(SELECT full_name FROM "user" WHERE id = ${scope.actor.userId})`,
    });
  }

  /** The sheet's columns, and the status when one is given. True ⇒ a row changed. */
  async update(tx: Transaction, kaizenId: string, columns: KaizenColumns): Promise<boolean> {
    const updated = await tx
      .update(kaizens)
      .set(columns)
      .where(eq(kaizens.id, kaizenId))
      .returning({ id: kaizens.id });
    return updated.length > 0;
  }

  async submit(tx: Transaction, kaizenId: string, submissionId: string): Promise<boolean> {
    const updated = await tx
      .update(kaizens)
      .set({
        status: 'SUBMITTED',
        // First submission only; a resubmission keeps the period it was counted in.
        submittedAt: sql`COALESCE(${kaizens.submittedAt}, now())`,
        lastSubmissionId: submissionId,
      })
      .where(and(eq(kaizens.id, kaizenId), inArray(kaizens.status, ['DRAFT', 'SENT_BACK'])))
      .returning({ id: kaizens.id });
    return updated.length > 0;
  }

  /**
   * The review row, then the move it makes — in that order, because 0044's trigger refuses
   * a move off SUBMITTED with no review of this transaction behind it.
   */
  async review(
    tx: Transaction,
    scope: ScopeContext,
    kaizenId: string,
    decision: KaizenReviewDecision,
    comment: string | null,
  ): Promise<KaizenReviewRow | null> {
    const moved = await tx
      .select({ id: kaizens.id })
      .from(kaizens)
      .where(and(eq(kaizens.id, kaizenId), eq(kaizens.status, 'SUBMITTED')))
      .for('update');
    if (moved.length === 0) return null;

    const [review] = await tx
      .insert(kaizenReviews)
      .values({
        kaizenId,
        reviewerUserId: scope.actor.userId,
        reviewerName: sql`(SELECT full_name FROM "user" WHERE id = ${scope.actor.userId})`,
        reviewerRole: scope.actor.role,
        decision,
        comment,
      })
      .returning();
    await tx.update(kaizens).set({ status: decision }).where(eq(kaizens.id, kaizenId));
    return review!;
  }

  // --------------------------------------------------------------------- photos

  async findPhotoById(tx: Transaction, photoId: string): Promise<KaizenPhotoRow | null> {
    const [row] = await tx.select().from(kaizenPhotos).where(eq(kaizenPhotos.id, photoId)).limit(1);
    return row ?? null;
  }

  async insertPhoto(tx: Transaction, values: typeof kaizenPhotos.$inferInsert): Promise<void> {
    await tx.insert(kaizenPhotos).values(values);
  }

  /** Marks the upload confirmed and enqueues its EXIF strip on the same transaction (R-2). */
  async commitPhoto(
    scope: ScopeContext,
    photoId: string,
    values: { uploadedAt: Date; width: number | null; height: number | null },
    onCommitted: (tx: Transaction) => Promise<void>,
  ): Promise<void> {
    await this.inTransaction(scope, async (tx) => {
      await tx.update(kaizenPhotos).set(values).where(eq(kaizenPhotos.id, photoId));
      await onCommitted(tx);
    });
  }

  /** The EXIF strip's write-back: what is in storage now, when the worker had to rewrite it. */
  async recordPhotoSanitised(scope: ScopeContext, photoId: string, storedChecksumSha256: string): Promise<void> {
    await this.inTransaction(scope, (tx) =>
      tx.update(kaizenPhotos).set({ storedChecksumSha256 }).where(eq(kaizenPhotos.id, photoId)),
    );
  }

  /** Soft delete (D8). 0044's trigger allows it only while the Kaizen is editable. */
  async removePhoto(tx: Transaction, scope: ScopeContext, photoId: string): Promise<void> {
    await tx
      .update(kaizenPhotos)
      .set({ deletedAt: new Date(), deletedByUserId: scope.actor.userId })
      .where(and(eq(kaizenPhotos.id, photoId), isNull(kaizenPhotos.deletedAt)));
  }

  // -------------------------------------------------------------------- helpers

  private select(tx: Transaction) {
    return tx
      .select(rowColumns)
      .from(kaizens)
      .innerJoin(units, eq(units.id, kaizens.unitId))
      .innerJoin(zones, eq(zones.id, kaizens.zoneId));
  }
}

function flatten(row: {
  kaizen: typeof kaizens.$inferSelect;
  unitName: string;
  zoneCode: string;
  zoneName: string;
  department: string | null;
}): KaizenRow {
  const { kaizen, ...rest } = row;
  return { ...kaizen, ...rest };
}
