import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  audits,
  auditZones,
  evidence,
  questionResponses,
  units,
  type Database,
  type Transaction,
} from '@audit5s/db';
import { classifyScore, type ScopeContext } from '@audit5s/domain';
import type {
  EvidenceClassification,
  EvidenceKind,
  ListAuditEvidenceQuery,
  ListEvidenceQuery,
  LocationProvider,
  ResponseValue,
  SyncState,
} from '@audit5s/contracts';
import { BaseRepository } from '../../common/repository/base.repository';
import { ScopeResolverRegistry } from '../../common/auth/resolvers';
import { DATABASE } from '../../infrastructure/database/database.module';
import { setActorContext } from '../users/users.repository';

/**
 * Evidence rows (§5.6, §8.7).
 *
 * Evidence is scoped through its audit, which is why every read here joins `audit` and
 * applies the predicate to *that* table's columns: §5.6 gives `evidence` no `unit_id` of
 * its own, and inventing one would be a second copy of the tenancy anchor that could drift
 * from the audit's.
 */

/** Evidence inherits both scope columns from the audit it belongs to. */
const evidenceScopeColumns = { unitId: audits.unitId, ownerUserId: audits.auditorUserId };

const evidenceColumns = {
  id: evidence.id,
  kind: evidence.kind,
  auditId: evidence.auditId,
  auditZoneId: evidence.auditZoneId,
  questionResponseId: evidence.questionResponseId,
  correctiveActionSubmissionId: evidence.correctiveActionSubmissionId,
  objectKey: evidence.objectKey,
  thumbnailObjectKey: evidence.thumbnailObjectKey,
  mediaProcessedAt: evidence.mediaProcessedAt,
  storedChecksumSha256: evidence.storedChecksumSha256,
  contentType: evidence.contentType,
  byteSize: evidence.byteSize,
  width: evidence.width,
  height: evidence.height,
  checksumSha256: evidence.checksumSha256,
  localDeviceId: evidence.localDeviceId,
  scoreAtCapture: evidence.scoreAtCapture,
  classification: evidence.classification,
  remark: evidence.remark,
  isSummaryFlagged: evidence.isSummaryFlagged,
  latitude: evidence.latitude,
  longitude: evidence.longitude,
  accuracyM: evidence.accuracyM,
  locationProvider: evidence.locationProvider,
  capturedAt: evidence.capturedAt,
  uploadedAt: evidence.uploadedAt,
  syncState: evidence.syncState,
  isLiveCapture: evidence.isLiveCapture,
  deletedAt: evidence.deletedAt,
  redactedAt: evidence.redactedAt,
  redactionReason: evidence.redactionReason,
  createdAt: evidence.createdAt,
  auditStatus: audits.status,
  auditUnitId: audits.unitId,
  auditorUserId: audits.auditorUserId,
  owningDeviceId: audits.owningDeviceId,
};

export interface CreateEvidenceInput {
  id: string;
  kind: EvidenceKind;
  auditId: string;
  auditZoneId: string | null;
  questionResponseId: string | null;
  objectKey: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
  localDeviceId: string | null;
  localFileUri: string | null;
  scoreAtCapture: ResponseValue | null;
  classification: EvidenceClassification;
  remark: string | null;
  isLiveCapture: boolean;
  capturedAt: Date;
  location: {
    latitude: number;
    longitude: number;
    accuracyM: number | null;
    provider: LocationProvider;
  } | null;
}

@Injectable()
export class EvidenceRepository extends BaseRepository {
  constructor(@Inject(DATABASE) db: Database, resolvers: ScopeResolverRegistry) {
    super(db, resolvers);
  }

  /**
   * The metadata half of §9.4's two-phase commit.
   *
   * `onConflictDoNothing` rather than an upsert: §8.7 says "same `id` returns the same
   * intent", and a retried intent must not be able to move the object key under an upload
   * that is already in flight. The caller reads the row back and returns what is there.
   */
  async createIntent(scope: ScopeContext, input: CreateEvidenceInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .insert(evidence)
        .values({
          id: input.id,
          kind: input.kind,
          auditId: input.auditId,
          auditZoneId: input.auditZoneId,
          questionResponseId: input.questionResponseId,
          objectKey: input.objectKey,
          contentType: input.contentType,
          byteSize: input.byteSize,
          checksumSha256: input.checksumSha256,
          localDeviceId: input.localDeviceId,
          localFileUri: input.localFileUri,
          scoreAtCapture: input.scoreAtCapture,
          classification: input.classification,
          remark: input.remark,
          isLiveCapture: input.isLiveCapture,
          capturedAt: input.capturedAt,
          // SYNCING from the first moment: the row exists, the bytes do not yet (§7.4).
          syncState: 'SYNCING',
          ...(input.location
            ? {
                latitude: input.location.latitude.toFixed(6),
                longitude: input.location.longitude.toFixed(6),
                accuracyM: input.location.accuracyM?.toFixed(2) ?? null,
                locationProvider: input.location.provider,
              }
            : {}),
        })
        .onConflictDoNothing({ target: evidence.id });
    });
  }

  async findById(scope: ScopeContext, evidenceId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select(evidenceColumns)
        .from(evidence)
        .innerJoin(audits, eq(audits.id, evidence.auditId))
        .where(and(eq(evidence.id, evidenceId), this.scoped(scope, evidenceScopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * Reads an evidence row by id **without** a scope predicate, for the intent-idempotency
   * path alone — the same carve-out and the same reasoning as
   * `AuditsRepository.findForCreateIdempotency`.
   *
   * A device retrying `upload-intent` must be told the row already exists even when it
   * belongs to someone else; otherwise the retry inserts and hits a primary-key violation
   * the client cannot interpret. The caller compares the owner and refuses; it never
   * returns the row to a stranger.
   */
  async findForIntentIdempotency(scope: ScopeContext, evidenceId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: evidence.id,
          auditId: evidence.auditId,
          objectKey: evidence.objectKey,
          contentType: evidence.contentType,
          byteSize: evidence.byteSize,
          checksumSha256: evidence.checksumSha256,
          syncState: evidence.syncState,
          auditorUserId: audits.auditorUserId,
        })
        .from(evidence)
        .innerJoin(audits, eq(audits.id, evidence.auditId))
        .where(eq(evidence.id, evidenceId))
        .limit(1);
      return row ?? null;
    });
  }

  async listForZone(scope: ScopeContext, auditZoneId: string, query: ListEvidenceQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        eq(evidence.auditZoneId, auditZoneId),
        query.classification ? eq(evidence.classification, query.classification) : undefined,
        query.kind ? eq(evidence.kind, query.kind) : undefined,
        query.includeDeleted ? undefined : isNull(evidence.deletedAt),
        query.summaryFlaggedOnly ? eq(evidence.isSummaryFlagged, true) : undefined,
        query.cursor ? sql`${evidence.id} > ${query.cursor}` : undefined,
      ];

      return tx
        .select(evidenceColumns)
        .from(evidence)
        .innerJoin(audits, eq(audits.id, evidence.auditId))
        .where(this.scoped(scope, evidenceScopeColumns, ...filters))
        .orderBy(asc(evidence.id))
        .limit(query.limit + 1);
    });
  }

  /**
   * The whole audit's gallery, filtered the same way the per-Zone one is.
   *
   * Ordered by `id` rather than `captured_at` because the cursor is the id (§8.1 forbids
   * offset paging on audit tables), and a cursor that does not match the sort order skips
   * rows silently as the page advances — which on an append-only table is the failure
   * cursor paging exists to prevent. `id` is a UUIDv7, so id order *is* capture order.
   */
  async listForAudit(scope: ScopeContext, auditId: string, query: ListAuditEvidenceQuery) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);

      const filters: Array<SQL | undefined> = [
        eq(evidence.auditId, auditId),
        query.auditZoneId ? eq(evidence.auditZoneId, query.auditZoneId) : undefined,
        query.classification ? eq(evidence.classification, query.classification) : undefined,
        query.kind ? eq(evidence.kind, query.kind) : undefined,
        query.includeDeleted ? undefined : isNull(evidence.deletedAt),
        query.summaryFlaggedOnly ? eq(evidence.isSummaryFlagged, true) : undefined,
        query.cursor ? sql`${evidence.id} > ${query.cursor}` : undefined,
      ];

      return tx
        .select(evidenceColumns)
        .from(evidence)
        .innerJoin(audits, eq(audits.id, evidence.auditId))
        .where(this.scoped(scope, evidenceScopeColumns, ...filters))
        .orderBy(asc(evidence.id))
        .limit(query.limit + 1);
    });
  }

  /**
   * What the media worker writes, and the pg-boss job that asks it to (R-2).
   *
   * The enqueue is on the same transaction as the `commit` update, so a job cannot exist
   * for a photograph whose commit rolled back — which is the guarantee pg-boss was chosen
   * for and the reason there is no outbox table.
   */
  async markCommittedAndEnqueueMedia(
    scope: ScopeContext,
    evidenceId: string,
    input: {
      classification: EvidenceClassification;
      scoreAtCapture: ResponseValue | null;
      byteSize: number;
      width: number | null;
      height: number | null;
    },
    enqueue: (tx: Transaction) => Promise<void>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(evidence)
        .set({
          syncState: 'SYNCED' satisfies SyncState,
          uploadedAt: new Date(),
          classification: input.classification,
          scoreAtCapture: input.scoreAtCapture,
          byteSize: input.byteSize,
          ...(input.width !== null ? { width: input.width } : {}),
          ...(input.height !== null ? { height: input.height } : {}),
        })
        .where(eq(evidence.id, evidenceId));

      await enqueue(tx as Transaction);
    });
  }

  /**
   * The media worker's own write: the thumbnail key, the processed-at, and the stored
   * checksum when the object had to be sanitised.
   *
   * These three are R-12's addition to R-10's carve-out, so this statement is one of the
   * few that still succeeds on a completed audit's evidence. It is also why it names only
   * those columns: the trigger refuses the whole UPDATE if any other one moves.
   */
  async recordMediaProcessed(
    scope: ScopeContext,
    evidenceId: string,
    input: { thumbnailObjectKey: string | null; storedChecksumSha256: string | null },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // The committing auditor's own context. There is no system bypass by design — the
      // `evidence_update` policy admits `audit.auditor_user_id = app_actor_id()` — so the
      // worker becomes the auditor whose commit queued it (see `MediaWorker`).
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(evidence)
        .set({
          thumbnailObjectKey: input.thumbnailObjectKey,
          storedChecksumSha256: input.storedChecksumSha256,
          mediaProcessedAt: new Date(),
        })
        .where(eq(evidence.id, evidenceId));
    });
  }

  /** The row the media worker needs, under the committing auditor's scope. */
  async findForMediaProcessing(scope: ScopeContext, evidenceId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: evidence.id,
          objectKey: evidence.objectKey,
          contentType: evidence.contentType,
          byteSize: evidence.byteSize,
          checksumSha256: evidence.checksumSha256,
          storedChecksumSha256: evidence.storedChecksumSha256,
          thumbnailObjectKey: evidence.thumbnailObjectKey,
          mediaProcessedAt: evidence.mediaProcessedAt,
          deletedAt: evidence.deletedAt,
          redactedAt: evidence.redactedAt,
        })
        .from(evidence)
        .innerJoin(audits, eq(audits.id, evidence.auditId))
        .where(and(eq(evidence.id, evidenceId), this.scoped(scope, evidenceScopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * Marks the object confirmed (§9.4), and derives `classification` while doing it.
   *
   * Idempotent by construction: the same statement on an already-SYNCED row writes the
   * same values. §9.6 makes replaying `commit` the crash-recovery path for "app killed
   * between the S3 PUT and the commit", so this has to be safe to call twice, not merely
   * tolerable.
   */
  async markCommitted(
    scope: ScopeContext,
    evidenceId: string,
    input: {
      classification: EvidenceClassification;
      scoreAtCapture: ResponseValue | null;
      byteSize: number;
      width: number | null;
      height: number | null;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(evidence)
        .set({
          syncState: 'SYNCED' satisfies SyncState,
          uploadedAt: new Date(),
          classification: input.classification,
          scoreAtCapture: input.scoreAtCapture,
          byteSize: input.byteSize,
          ...(input.width !== null ? { width: input.width } : {}),
          ...(input.height !== null ? { height: input.height } : {}),
        })
        .where(eq(evidence.id, evidenceId));
    });
  }

  async patch(
    scope: ScopeContext,
    evidenceId: string,
    patch: {
      remark?: string | null;
      isSummaryFlagged?: boolean;
      /** Walk-by only (E-1); the service refuses it on every other kind. */
      classification?: EvidenceClassification;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx.update(evidence).set(patch).where(eq(evidence.id, evidenceId));
    });
  }

  /** E-4's soft delete. There is no hard delete: the trigger refuses one at any status. */
  async softDelete(scope: ScopeContext, evidenceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(evidence)
        .set({ deletedAt: new Date(), deletedByUserId: scope.actor.userId })
        .where(eq(evidence.id, evidenceId));
    });
  }

  /**
   * Invariant E-2: when a response's value changes before completion, every attached
   * evidence row's `classification` and `score_at_capture` are recomputed **in the same
   * transaction**.
   *
   * The same transaction matters. §5.6 gives the reason in one line — "otherwise a photo
   * silently misfiles into the wrong report section" — and a photo that is a GOOD in the
   * database and a NONCONFORMITY in the auditor's head is a corrective action nobody is
   * ever asked to close.
   *
   * The summary flag comes off when the new classification cannot carry one (E-3), because
   * the CHECK constraint would otherwise refuse the whole statement and the response edit
   * would fail for a reason the auditor could not act on.
   */
  async reclassifyForResponse(
    scope: ScopeContext,
    responseId: string,
    value: ResponseValue,
  ): Promise<number> {
    const classification = classifyScore(value);
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const rows = await tx
        .update(evidence)
        .set({
          classification,
          scoreAtCapture: value,
          ...(classification === 'NEUTRAL' ? { isSummaryFlagged: false } : {}),
        })
        .where(and(eq(evidence.questionResponseId, responseId), isNull(evidence.deletedAt)))
        .returning({ id: evidence.id });
      return rows.length;
    });
  }

  /**
   * The §7.2 walk-by guard, and the E-4 precondition: at least one non-deleted photo.
   *
   * Counted in SQL rather than by listing and measuring, because the caller only needs the
   * predicate and a Zone may hold a hundred photos.
   */
  async countLiveEvidenceInZone(scope: ScopeContext, auditZoneId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(evidence)
        .where(and(eq(evidence.auditZoneId, auditZoneId), isNull(evidence.deletedAt)));
      return row?.count ?? 0;
    });
  }

  /**
   * The selfie lookup behind `SelfieRequirement` — §7.1's `selfie_captured` guard.
   *
   * `sync_state` is deliberately not filtered. A selfie whose bytes are still in the
   * device's media queue is a captured selfie: §9.1 makes SQLite the source of truth while
   * an audit is in progress, and requiring the upload to have landed would put the network
   * back in front of the questionnaire.
   */
  async findSelfieForAudit(scope: ScopeContext, auditId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: evidence.id,
          kind: evidence.kind,
          isLiveCapture: evidence.isLiveCapture,
          syncState: evidence.syncState,
          deletedAt: evidence.deletedAt,
        })
        .from(evidence)
        .where(
          and(
            eq(evidence.auditId, auditId),
            eq(evidence.kind, 'AUDITOR_SELFIE'),
            isNull(evidence.deletedAt),
          ),
        )
        .orderBy(asc(evidence.capturedAt))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * §7.2's `DRAFT → IN_PROGRESS` edge for a walk-by: "first response saved (full audit)
   * **or first photo captured (walk-by)**".
   *
   * A walk-by has no questionnaire, so the response upsert — which is what moves a scored
   * Zone — never fires. Without this a walk-by Zone stays in DRAFT for its whole life and
   * `IN_PROGRESS → COMPLETED` is refused as an edge that does not exist, which is a
   * confusing way to say "this Zone never started".
   *
   * Guarded on the current status rather than set unconditionally: a Zone that is already
   * IN_PROGRESS must not have its `started_at` pushed forward by the fourth photograph.
   */
  async startZoneOnFirstCapture(
    scope: ScopeContext,
    auditZoneId: string,
    capturedAt: Date,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(auditZones)
        .set({ status: 'IN_PROGRESS', startedAt: capturedAt })
        .where(and(eq(auditZones.id, auditZoneId), eq(auditZones.status, 'DRAFT')));
    });
  }

  /**
   * Points the audit at its selfie, once and never again.
   *
   * `WHERE selfie_evidence_id IS NULL` rather than an unconditional SET: a second selfie —
   * a retake, or a replayed sync — must not move the pointer the report already rendered
   * from. The first one captured is the one the audit is conducted under.
   */
  async attachSelfieToAudit(
    scope: ScopeContext,
    auditId: string,
    evidenceId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      await tx
        .update(audits)
        .set({ selfieEvidenceId: evidenceId })
        .where(and(eq(audits.id, auditId), isNull(audits.selfieEvidenceId)));
    });
  }

  /** The linked response, for E-1 at commit. Read under the audit's own scope. */
  async findResponseForEvidence(scope: ScopeContext, responseId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: questionResponses.id,
          auditId: questionResponses.auditId,
          auditZoneId: questionResponses.auditZoneId,
          value: questionResponses.value,
        })
        .from(questionResponses)
        .innerJoin(audits, eq(audits.id, questionResponses.auditId))
        .where(and(eq(questionResponses.id, responseId), this.scoped(scope, evidenceScopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  /** The audit and its Unit, for the object key and the scope check in one read. */
  async findAuditForEvidence(scope: ScopeContext, auditId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: audits.id,
          unitId: audits.unitId,
          status: audits.status,
          auditType: audits.auditType,
          auditorUserId: audits.auditorUserId,
          owningDeviceId: audits.owningDeviceId,
          unitName: units.name,
        })
        .from(audits)
        .innerJoin(units, eq(units.id, audits.unitId))
        .where(and(eq(audits.id, auditId), this.scoped(scope, evidenceScopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  /** Confirms an audit Zone belongs to the audit the intent names. */
  async findZoneForEvidence(scope: ScopeContext, auditZoneId: string) {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({
          id: auditZones.id,
          auditId: auditZones.auditId,
          status: auditZones.status,
        })
        .from(auditZones)
        .innerJoin(audits, eq(audits.id, auditZones.auditId))
        .where(and(eq(auditZones.id, auditZoneId), this.scoped(scope, evidenceScopeColumns)))
        .limit(1);
      return row ?? null;
    });
  }

  /**
   * Evidence whose object never arrived — §9.4's `orphan_metadata`.
   *
   * Read on `GET /sync/status` so the device that owns the gap is the one told about it,
   * and swept by the reconciliation job of PART 16.4.
   */
  async countAwaitingUpload(scope: ScopeContext, deviceId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      const [row] = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(evidence)
        .innerJoin(audits, eq(audits.id, evidence.auditId))
        .where(
          this.scoped(
            scope,
            evidenceScopeColumns,
            eq(evidence.localDeviceId, deviceId),
            inArray(evidence.syncState, ['SYNCING', 'PENDING', 'FAILED']),
            isNull(evidence.deletedAt),
          ),
        );
      return row?.count ?? 0;
    });
  }

  /** Used by the transactional paths that already hold a transaction. */
  async withTransaction<T>(
    scope: ScopeContext,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await setActorContext(tx, scope.actor.userId, scope.actor.role);
      return work(tx);
    });
  }
}

export type EvidenceRow = NonNullable<Awaited<ReturnType<EvidenceRepository['findById']>>>;
