import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  correctiveActions,
  auditZones,
  checklistQuestions,
  reportAccessTokens,
  reportSnapshots,
  users,
  withAuthPhase,
  type Database,
  type Transaction,
} from '@audit5s/db';
import type { ScopeContext } from '@audit5s/domain';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

/**
 * Report access tokens (§5.8, §10.4).
 *
 * `resolve` is the one method that runs in the **auth phase** rather than as an actor, and
 * for exactly the reason `/auth/login` does: the token *is* the credential, so it has to
 * be looked up before there is anybody to be. The window is opened by this method alone,
 * it is closed by the end of its transaction, and the lookup key is a 256-bit secret.
 *
 * Every other method here is an ordinary Super Admin read or write.
 */
export type ReportAccessTokenRow = typeof reportAccessTokens.$inferSelect;
export type ReportAccessTokenInsert = typeof reportAccessTokens.$inferInsert;

export interface ResolvedToken extends ReportAccessTokenRow {
  issuedToRole: string | null;
  issuedToName: string | null;
  issuedToActiveUnitId: string | null;
  /** The account that generated the report, while it is still active (R-22). */
  issuedByRole: string | null;
  issuedByName: string | null;
}

@Injectable()
export class ReportTokensRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  /** Minted on the caller's transaction, so tokens and their snapshot commit together. */
  async mint(tx: Transaction, rows: readonly ReportAccessTokenInsert[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(reportAccessTokens).values([...rows]);
  }

  /**
   * Look a link up by the hash of its secret, and record the use in the same transaction.
   *
   * Returning the row **and** bumping `use_count` together is what makes §10.4's "every use
   * recorded" true under concurrency: two tabs opening the same link produce two uses, not
   * one, and a `max_uses` of 1 admits exactly one of them.
   */
  async resolveAndRecordUse(
    tokenHash: string,
    ipAddress: string | null,
  ): Promise<ResolvedToken | null> {
    return withAuthPhase(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(reportAccessTokens)
        .where(eq(reportAccessTokens.tokenHash, tokenHash))
        .limit(1);
      if (!row) return null;

      // Recorded even for a token about to be refused: a revoked link being tried is
      // exactly the event a Super Admin would want to see in the audit trail.
      await tx
        .update(reportAccessTokens)
        .set({
          useCount: sql`${reportAccessTokens.useCount} + 1`,
          lastUsedAt: new Date(),
          lastUsedIp: ipAddress,
        })
        .where(eq(reportAccessTokens.id, row.id));

      const [holder] = row.issuedToUserId
        ? await tx
            .select({
              role: users.role,
              fullName: users.fullName,
              status: users.status,
              archivedAt: users.archivedAt,
            })
            .from(users)
            .where(eq(users.id, row.issuedToUserId))
            .limit(1)
        : [];

      const usable = holder && holder.archivedAt === null && holder.status === 'ACTIVE';

      // The report's issuer: whom the link acts as when no Zone Leader is attached (R-22).
      const [issuer] = await tx
        .select({
          role: users.role,
          fullName: users.fullName,
          status: users.status,
          archivedAt: users.archivedAt,
        })
        .from(users)
        .where(eq(users.id, row.createdByUserId))
        .limit(1);
      const issuerUsable = issuer && issuer.archivedAt === null && issuer.status === 'ACTIVE';

      return {
        ...row,
        useCount: row.useCount + 1,
        issuedToRole: usable ? holder.role : null,
        issuedToName: usable ? holder.fullName : null,
        issuedToActiveUnitId: usable ? row.unitId : null,
        issuedByRole: issuerUsable ? issuer.role : null,
        issuedByName: issuerUsable ? issuer.fullName : null,
      } satisfies ResolvedToken;
    });
  }

  /** §8.9's token list, with what each link addresses so the screen need not join. */
  async listForSnapshot(scope: ScopeContext, snapshotId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return tx
        .select({
          token: reportAccessTokens,
          issuedToName: users.fullName,
          zoneCode: auditZones.zoneCodeSnapshot,
          questionGlobalOrder: checklistQuestions.globalOrder,
        })
        .from(reportAccessTokens)
        .leftJoin(users, eq(users.id, reportAccessTokens.issuedToUserId))
        .leftJoin(correctiveActions, eq(correctiveActions.id, reportAccessTokens.correctiveActionId))
        .leftJoin(auditZones, eq(auditZones.id, correctiveActions.auditZoneId))
        .leftJoin(
          checklistQuestions,
          eq(checklistQuestions.id, correctiveActions.checklistQuestionId),
        )
        .where(eq(reportAccessTokens.snapshotId, snapshotId))
        .orderBy(asc(reportAccessTokens.createdAt), asc(reportAccessTokens.id));
    });
  }

  /**
   * CA9: the action, and the newest report still listed that printed a link to it — the
   * report a further link is attached to, so the Reports page lists and revokes it too.
   * `snapshotId` is null when no listed report has printed one.
   */
  async linkTarget(scope: ScopeContext, actionId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [action] = await tx
        .select({
          id: correctiveActions.id,
          unitId: correctiveActions.unitId,
          status: correctiveActions.status,
          assignedZoneLeaderUserId: correctiveActions.assignedZoneLeaderUserId,
        })
        .from(correctiveActions)
        .where(this.scoped(scope, { unitId: correctiveActions.unitId }, eq(correctiveActions.id, actionId)))
        .limit(1);
      if (!action) return null;
      const [printed] = await tx
        .select({ snapshotId: reportAccessTokens.snapshotId })
        .from(reportAccessTokens)
        .innerJoin(reportSnapshots, eq(reportSnapshots.id, reportAccessTokens.snapshotId))
        .where(
          and(
            eq(reportAccessTokens.correctiveActionId, actionId),
            eq(reportAccessTokens.purpose, 'CORRECTIVE_ACTION'),
            ne(reportSnapshots.status, 'REMOVED'),
            this.scoped(scope, { unitId: reportAccessTokens.unitId }),
          ),
        )
        .orderBy(desc(reportAccessTokens.createdAt), desc(reportAccessTokens.id))
        .limit(1);
      return { ...action, snapshotId: printed?.snapshotId ?? null };
    });
  }

  /** CA9: one link, on its own transaction. */
  async mintOne(scope: ScopeContext, row: ReportAccessTokenInsert): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await this.mint(tx, [row]);
    });
  }

  async findById(scope: ScopeContext, tokenId: string): Promise<ReportAccessTokenRow | null> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select()
        .from(reportAccessTokens)
        .where(eq(reportAccessTokens.id, tokenId))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * Revoke, once. A second revoke of the same link is a no-op rather than an overwrite:
   * the first reason and the first revoker are the record of what happened.
   */
  async revoke(
    scope: ScopeContext,
    tokenId: string,
    reason: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const updated = await tx
        .update(reportAccessTokens)
        .set({
          revokedAt: new Date(),
          revokedByUserId: scope.actor.userId,
          revokeReason: reason,
        })
        .where(and(eq(reportAccessTokens.id, tokenId), isNull(reportAccessTokens.revokedAt)))
        .returning({ id: reportAccessTokens.id });
      return updated.length > 0;
    });
  }
}
