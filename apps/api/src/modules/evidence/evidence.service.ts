import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CommitEvidenceRequest,
  Evidence,
  EvidenceVariant,
  EvidenceViewUrl,
  ListAuditEvidenceQuery,
  ListEvidenceQuery,
  Page,
  PatchEvidenceRequest,
  UploadIntentRequest,
  UploadIntentResponse,
} from '@audit5s/contracts';
import {
  ALLOWED_IMAGE_TYPES,
  auditorChoosesClassification,
  awaitsResponse,
  canBeSummaryFlagged,
  classifyEvidence,
  evidenceObjectKey,
  isAuditCompleted,
  sniffImageType,
  type ScopeContext,
} from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { isUniqueViolation } from '../../common/pg-errors';
import { CONFIG, type AppConfig } from '../../config/env';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { CorrectiveActionsService } from '../corrective-actions/corrective-actions.service';
import { EvidenceRepository, type EvidenceRow } from './evidence.repository';

/**
 * Evidence (§8.7, §9.4, §12.8).
 *
 * The shape of this service is §9.4's two-phase commit, and the two phases are separate
 * because §5 requires that media never transits the API:
 *
 *   `upload-intent` writes the metadata row and mints a presigned PUT;
 *   the device uploads the bytes **directly** to storage;
 *   `commit` HEADs the object, verifies size and checksum, sniffs the magic bytes, and
 *   derives the classification.
 *
 * Both halves are idempotent, and not as a courtesy: §9.6 makes a replayed `commit` the
 * recovery path for an app killed between the PUT and the confirmation, and a second
 * `upload-intent` the recovery path for one killed before the PUT. A device that crashes
 * at the worst moment recovers by doing the same thing again.
 */
@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name);

  constructor(
    private readonly repository: EvidenceRepository,
    private readonly storage: ObjectStorage,
    private readonly queue: QueueService,
    private readonly correctiveActions: CorrectiveActionsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ upload intent

  async createUploadIntent(
    scope: ScopeContext,
    request: UploadIntentRequest,
  ): Promise<UploadIntentResponse> {
    // §8.7: "Same `id` returns the same intent." Checked before anything is written, so a
    // retry cannot mint a second key for an upload that may already be in flight.
    const existing = await this.repository.findForIntentIdempotency(scope, request.id);
    if (existing) {
      // An after-photo belongs to whoever may answer its action, not to the auditor.
      const retrying =
        existing.kind === 'CORRECTIVE_AFTER'
          ? existing.correctiveActionId !== null &&
            (await this.correctiveActions.findAnswerable(scope, existing.correctiveActionId)) !== null
          : existing.auditorUserId === scope.actor.userId;
      if (!retrying) {
        throw AppError.conflict(
          'CONFLICT',
          'Evidence already exists with this id and belongs to another auditor',
        );
      }
      const upload = await this.storage.presignPut(existing.objectKey, {
        expiresInSeconds: this.config.EVIDENCE_PUT_URL_TTL_SECONDS,
        contentType: existing.contentType,
        byteSize: Number(existing.byteSize),
        checksumSha256: existing.checksumSha256,
      });
      return {
        evidenceId: existing.id,
        objectKey: existing.objectKey,
        uploadUrl: upload.url,
        requiredHeaders: upload.requiredHeaders,
        expiresIn: upload.expiresIn,
        alreadyExists: true,
      };
    }

    if (request.kind === 'CORRECTIVE_AFTER') {
      return this.createAfterPhotoIntent(scope, request);
    }

    const audit = await this.repository.findAuditForEvidence(scope, request.auditId);
    if (!audit) {
      // AZ-3: an audit outside scope reads as absent, so ids cannot be probed.
      throw AppError.notFound('No such audit');
    }
    this.assertWritable(audit.status, scope, audit.owningDeviceId);

    const auditZoneId = await this.resolveZone(scope, request, audit.id);
    const linkedResponse = await this.resolveResponse(scope, request, audit.id);

    // Invariant E-1: derived here, never taken from the request. The auditor's choice is
    // consulted for a walk-by photo and for nothing else.
    const classification = classifyEvidence({
      kind: request.kind,
      scoreAtCapture: linkedResponse?.value ?? null,
      auditorSelected: request.classification ?? null,
    });

    const objectKey = evidenceObjectKey({
      kind: request.kind,
      unitId: audit.unitId,
      auditId: audit.id,
      auditZoneId,
      evidenceId: request.id,
      extension: ALLOWED_IMAGE_TYPES[request.contentType],
    });

    await this.repository.createIntent(scope, {
      id: request.id,
      kind: request.kind,
      auditId: audit.id,
      auditZoneId,
      questionResponseId: linkedResponse?.id ?? null,
      objectKey,
      contentType: request.contentType,
      byteSize: request.byteSize,
      checksumSha256: request.checksumSha256,
      localDeviceId: scope.actor.deviceId ?? null,
      localFileUri: request.localFileUri ?? null,
      scoreAtCapture: linkedResponse?.value ?? null,
      classification,
      remark: request.remark ?? null,
      isLiveCapture: request.isLiveCapture,
      capturedAt: new Date(request.capturedAt),
      location: request.location
        ? {
            latitude: request.location.latitude,
            longitude: request.location.longitude,
            accuracyM: request.location.accuracyM ?? null,
            provider: request.location.provider,
          }
        : null,
    });

    if (auditZoneId) {
      // §7.2: a Zone starts on the first response *or the first photograph*. The response
      // upsert covers the scored case; a walk-by has no questionnaire, so this is the only
      // thing that ever moves its Zone off DRAFT.
      await this.repository.startZoneOnFirstCapture(
        scope,
        auditZoneId,
        new Date(request.capturedAt),
      );
    }

    const upload = await this.storage.presignPut(objectKey, {
      expiresInSeconds: this.config.EVIDENCE_PUT_URL_TTL_SECONDS,
      contentType: request.contentType,
      byteSize: request.byteSize,
      checksumSha256: request.checksumSha256,
    });

    return {
      evidenceId: request.id,
      objectKey,
      uploadUrl: upload.url,
      requiredHeaders: upload.requiredHeaders,
      expiresIn: upload.expiresIn,
      alreadyExists: false,
    };
  }

  /**
   * A Zone Leader's after-photo (§7.3 Option A, R-13).
   *
   * It hangs off an audit that is completed by definition, so the audit's write rules do
   * not apply; the action's do. The photograph is keyed to the attempt the device minted
   * when the form opened (§5.6), and it must be a live capture — the flow offers no other
   * way to take one, and the submission refuses one that says otherwise (CA-2).
   */
  private async createAfterPhotoIntent(
    scope: ScopeContext,
    request: UploadIntentRequest,
  ): Promise<UploadIntentResponse> {
    if (!request.correctiveActionId || !request.correctiveActionSubmissionId) {
      throw AppError.validation('An after-photo names its corrective action and attempt', [
        { field: 'correctiveActionId', message: 'Required for CORRECTIVE_AFTER' },
        { field: 'correctiveActionSubmissionId', message: 'Required for CORRECTIVE_AFTER' },
      ]);
    }
    if (!request.isLiveCapture) {
      throw AppError.validation('An after-photo must be a live capture (§12.10)', [
        { field: 'isLiveCapture', message: 'Must be true' },
      ]);
    }

    const action = await this.correctiveActions.findAnswerable(scope, request.correctiveActionId);
    if (!action || action.auditId !== request.auditId) {
      throw AppError.notFound('No such corrective action');
    }
    if (!awaitsResponse(action.status)) {
      throw AppError.conflict(
        'INVALID_STATE_TRANSITION',
        `This corrective action is ${action.status}; it is not waiting for a response`,
      );
    }

    const objectKey = evidenceObjectKey({
      kind: 'CORRECTIVE_AFTER',
      unitId: action.unitId,
      auditId: action.auditId,
      evidenceId: request.id,
      extension: ALLOWED_IMAGE_TYPES[request.contentType],
      correctiveActionId: action.id,
      correctiveActionSubmissionId: request.correctiveActionSubmissionId,
    });

    await this.repository.createIntent(scope, {
      id: request.id,
      kind: 'CORRECTIVE_AFTER',
      auditId: action.auditId,
      auditZoneId: null,
      questionResponseId: null,
      correctiveActionId: action.id,
      correctiveActionSubmissionId: request.correctiveActionSubmissionId,
      objectKey,
      contentType: request.contentType,
      byteSize: request.byteSize,
      checksumSha256: request.checksumSha256,
      localDeviceId: scope.actor.deviceId ?? null,
      localFileUri: request.localFileUri ?? null,
      scoreAtCapture: null,
      classification: classifyEvidence({ kind: 'CORRECTIVE_AFTER' }),
      remark: request.remark ?? null,
      isLiveCapture: true,
      capturedAt: new Date(request.capturedAt),
      location: request.location
        ? {
            latitude: request.location.latitude,
            longitude: request.location.longitude,
            accuracyM: request.location.accuracyM ?? null,
            provider: request.location.provider,
          }
        : null,
    });

    const upload = await this.storage.presignPut(objectKey, {
      expiresInSeconds: this.config.EVIDENCE_PUT_URL_TTL_SECONDS,
      contentType: request.contentType,
      byteSize: request.byteSize,
      checksumSha256: request.checksumSha256,
    });

    return {
      evidenceId: request.id,
      objectKey,
      uploadUrl: upload.url,
      requiredHeaders: upload.requiredHeaders,
      expiresIn: upload.expiresIn,
      alreadyExists: false,
    };
  }

  // ------------------------------------------------------------------------- commit

  /**
   * `POST /evidence/{id}/commit` (§8.7, §9.4).
   *
   * Four checks, in the order that fails cheapest first: the object exists, it is the size
   * the intent declared, its checksum matches, and its **bytes** are the image type it
   * claims (§12.8). Only then is the row SYNCED and the classification written.
   */
  async commit(
    scope: ScopeContext,
    evidenceId: string,
    request: CommitEvidenceRequest,
  ): Promise<Evidence> {
    const row = await this.mustFind(scope, evidenceId);

    if (request.checksumSha256 !== row.checksumSha256) {
      // The device is confirming a different object from the one it declared. Refused
      // before the storage round trip, because nothing it could find would be right.
      throw AppError.conflict(
        'CHECKSUM_MISMATCH',
        'The checksum in this commit differs from the one the upload intent declared',
      );
    }

    // §9.6: replaying a commit on an already-SYNCED row is the crash-recovery path, and
    // it returns the same body rather than doing the work twice.
    if (row.syncState === 'SYNCED' && row.uploadedAt) {
      return toEvidence(row);
    }

    const head = await this.storage.head(row.objectKey);
    if (!head) {
      // §9.4's "metadata without object". Not an error the device should give up on: the
      // upload may simply not have finished, and the reconciliation job flags it at 24 h.
      throw AppError.conflict(
        'EVIDENCE_NOT_UPLOADED',
        'The object is not in storage yet. Upload it to the presigned URL, then commit.',
      );
    }

    // The object in storage is the sanitised one once the media worker has been here
    // (R-12), so the size it declared at capture is no longer what is there. `byte_size`
    // is refreshed below from this same HEAD, so a replay compares against the truth.
    const sanitised = row.storedChecksumSha256 !== null;

    if (!sanitised && head.byteSize !== Number(row.byteSize)) {
      throw AppError.conflict(
        'CHECKSUM_MISMATCH',
        `The stored object is ${head.byteSize} bytes; the intent declared ${row.byteSize}`,
      );
    }

    // Null when the provider recorded no checksum — verify what is verifiable rather than
    // refusing a photo for an infrastructure reason (see `StoredObjectHead`).
    //
    // `storedChecksumSha256` wins when it is set: R-12 keeps `checksum_sha256` as the
    // capture-time fact §12.8 verified, and records what is actually in the bucket
    // separately. Comparing against the capture value here would answer
    // `409 CHECKSUM_MISMATCH` on the replay path §9.6 depends on, for a photograph the
    // server itself rewrote — and the device would retry until it dead-lettered a good
    // upload.
    const expectedChecksum = row.storedChecksumSha256 ?? row.checksumSha256;
    if (head.checksumSha256 !== null && head.checksumSha256 !== expectedChecksum) {
      throw AppError.conflict(
        'CHECKSUM_MISMATCH',
        'The stored object does not match the checksum recorded at capture',
      );
    }

    // §12.8: the presigned policy constrained what the client *claimed*; this is what it
    // actually sent. A ZIP renamed to .jpg gets this far and no further.
    const header = await this.storage.readRange(row.objectKey, 16);
    const sniffed = header ? sniffImageType(header) : null;
    if (sniffed === null) {
      throw AppError.badRequest(
        'UNSUPPORTED_MEDIA_TYPE',
        'Not an image',
        'The uploaded bytes are not a JPEG, PNG or WebP, whatever the declared content type said',
      );
    }

    // The classification is derived again at commit, from the response as it stands *now*
    // — the auditor may have answered the question between capture and upload.
    const linkedResponse = row.questionResponseId
      ? await this.repository.findResponseForEvidence(scope, row.questionResponseId)
      : null;

    const classification = classifyEvidence({
      kind: row.kind,
      scoreAtCapture: linkedResponse?.value ?? null,
      // The auditor's walk-by choice was recorded at intent; re-derivation preserves it.
      auditorSelected: row.kind === 'WALK_BY_PHOTO' ? row.classification : null,
    });

    // R-2: the enqueue is on the **same transaction** as the commit, so a job cannot
    // exist for a photograph whose commit rolled back. That is why pg-boss is the queue
    // and why there is no outbox table (DECISIONS.md R-2).
    await this.repository.markCommittedAndEnqueueMedia(
      scope,
      evidenceId,
      {
        classification,
        scoreAtCapture: linkedResponse?.value ?? null,
        byteSize: head.byteSize,
        width: request.width ?? null,
        height: request.height ?? null,
      },
      (tx) =>
        this.queue
          .sendInTransaction(tx, QUEUES.mediaProcess, {
            evidenceId,
            // Identity, never authority: the worker re-reads the role and the grant. It
            // is the committer because `evidence:create` is granted on `own_audits`, so
            // the actor here is the audit's own auditor.
            auditorUserId: scope.actor.userId,
          })
          .then(() => undefined),
    );

    if (row.kind === 'AUDITOR_SELFIE') {
      // §7.1's guard reads the audit; this is what points it at the selfie. It is a
      // no-op once set, so a retake or a replayed commit cannot move the pointer the
      // report will render from.
      await this.repository.attachSelfieToAudit(scope, row.auditId, evidenceId);
    }

    return this.get(scope, evidenceId);
  }

  // -------------------------------------------------------------------------- reads

  async get(scope: ScopeContext, evidenceId: string): Promise<Evidence> {
    return toEvidence(await this.mustFind(scope, evidenceId));
  }

  async listForZone(
    scope: ScopeContext,
    auditZoneId: string,
    query: ListEvidenceQuery,
  ): Promise<Page<Evidence>> {
    // The parent is checked before the collection is read, the way `ZonesService.list`
    // checks its Unit. A scope predicate alone would answer an out-of-scope Zone with an
    // empty page — which leaks nothing (AZ-3 is satisfied either way) but tells a client
    // with a stale id that the Zone has no photographs rather than that it cannot see it.
    if (!(await this.repository.findZoneForEvidence(scope, auditZoneId))) {
      throw AppError.notFound('No such audit Zone');
    }

    const rows = await this.repository.listForZone(scope, auditZoneId, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toEvidence), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  /**
   * The whole audit's gallery (`GET /audits/{auditId}/evidence`).
   *
   * Same page shape and same filters as the per-Zone listing, one level up: the admin
   * gallery and the summary report both ask "what did this audit find" rather than
   * "what did this Zone look like".
   */
  async listForAudit(
    scope: ScopeContext,
    auditId: string,
    query: ListAuditEvidenceQuery,
  ): Promise<Page<Evidence>> {
    if (!(await this.repository.findAuditForEvidence(scope, auditId))) {
      throw AppError.notFound('No such audit');
    }

    const rows = await this.repository.listForAudit(scope, auditId, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toEvidence), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  /**
   * `GET /evidence/{id}/view-url` — a short-TTL presigned GET, minted **after** the scope
   * check (§12.6).
   *
   * The order is the control: `mustFind` applies the actor's resolver, so a URL is only
   * ever minted for an object the actor could already read. Minting first and checking
   * afterwards would hand out a working link on the way to a 404.
   */
  async viewUrl(
    scope: ScopeContext,
    evidenceId: string,
    variant: EvidenceVariant = 'original',
  ): Promise<EvidenceViewUrl> {
    const row = await this.mustFind(scope, evidenceId);

    if (row.redactedAt) {
      // R-5: the object behind a redacted row is a placeholder. The link still works —
      // the report renders it as "Photo removed" — and this is where that becomes visible.
      this.logger.log(`view-url for redacted evidence ${evidenceId}`);
    }

    // PART 16 asks that galleries use thumbnails and fetch originals "only on demand". A
    // row whose thumbnail has not been produced yet falls back to the original rather
    // than failing: a tile showing the real photograph beats one showing nothing while a
    // queue drains, and the fallback costs one larger download rather than a broken page.
    const key =
      variant === 'thumbnail' && row.thumbnailObjectKey ? row.thumbnailObjectKey : row.objectKey;

    const download = await this.storage.presignGet(key, {
      expiresInSeconds: this.config.EVIDENCE_GET_URL_TTL_SECONDS,
    });

    return {
      url: download.url,
      expiresIn: download.expiresIn,
      expiresAt: new Date(Date.now() + download.expiresIn * 1000).toISOString(),
    };
  }

  // ------------------------------------------------------------------------- writes

  /**
   * `PATCH /evidence/{id}` — the remark and the summary flag.
   *
   * The flag conflict is caught from the database rather than pre-checked, because the
   * pre-check is exactly the race §5.6 put the partial unique indexes there to close: two
   * devices, or one device retrying, can both pass a `SELECT` and both `UPDATE`.
   */
  async patch(
    scope: ScopeContext,
    evidenceId: string,
    request: PatchEvidenceRequest,
  ): Promise<Evidence> {
    const row = await this.mustFind(scope, evidenceId);
    this.assertWritable(row.auditStatus, scope, row.owningDeviceId);

    if (row.deletedAt) {
      throw AppError.conflict('CONFLICT', 'This evidence was deleted');
    }

    // §2.7: the auditor's judgement on a walk-by photograph, changed after the fact.
    // Refused rather than ignored on every other kind — unlike the field on an upload
    // intent, nothing replays a patch, so a classification here is a caller asserting
    // something E-1 reserves to the server.
    if (request.classification !== undefined && !auditorChoosesClassification(row.kind)) {
      throw AppError.conflict(
        'CONFLICT',
        `A ${row.kind} photo's classification is derived from its response, not chosen ` +
          '(E-1). Only a walk-by photograph is the auditor’s to judge (§2.7).',
      );
    }

    const classification = request.classification ?? row.classification;

    // E-3, twice over: the flag being set now, and the flag already set on a photograph
    // whose classification is about to become NEUTRAL. The CHECK constraint refuses both,
    // and would refuse the *whole* statement — including the reclassification the auditor
    // actually asked for — so the flag is dropped here instead, in the same patch.
    if (request.isSummaryFlagged === true && !canBeSummaryFlagged(classification)) {
      throw AppError.conflict(
        'CONFLICT',
        'Only a GOOD or NONCONFORMITY photo can be the Zone summary; this one is NEUTRAL',
      );
    }

    const clearsFlag =
      row.isSummaryFlagged && !canBeSummaryFlagged(classification) && request.isSummaryFlagged !== true;

    try {
      await this.repository.patch(scope, evidenceId, {
        ...(request.remark !== undefined ? { remark: request.remark } : {}),
        ...(request.classification !== undefined ? { classification: request.classification } : {}),
        ...(request.isSummaryFlagged !== undefined
          ? { isSummaryFlagged: request.isSummaryFlagged }
          : clearsFlag
            ? { isSummaryFlagged: false }
            : {}),
      });
    } catch (error) {
      if (
        isUniqueViolation(error, 'evidence_one_flagged_good_per_zone') ||
        isUniqueViolation(error, 'evidence_one_flagged_nonconformity_per_zone')
      ) {
        throw AppError.conflict(
          'SUMMARY_FLAG_TAKEN',
          `Another ${classification} photo in this Zone is already flagged for the summary. ` +
            'Unflag it first.',
        );
      }
      throw error;
    }

    return this.get(scope, evidenceId);
  }

  /** `DELETE /evidence/{id}` — a soft delete, refused after completion (E-4). */
  async softDelete(scope: ScopeContext, evidenceId: string): Promise<Evidence> {
    const row = await this.mustFind(scope, evidenceId);

    if (row.deletedAt) {
      // Idempotent: a retried delete returns the row rather than raising.
      return toEvidence(row);
    }

    if (isAuditCompleted(row.auditStatus)) {
      throw AppError.conflict(
        'AUDIT_ALREADY_COMPLETED',
        'This audit is completed; its evidence can no longer be removed (E-4). ' +
          'A Super Admin may redact a photo, which keeps the record (R-5).',
      );
    }
    this.assertWritable(row.auditStatus, scope, row.owningDeviceId);

    await this.repository.softDelete(scope, evidenceId);
    return this.get(scope, evidenceId);
  }

  /**
   * Invariant E-2, called by the response-upsert path.
   *
   * Returns the number of photos reclassified so the caller can log it: a response change
   * that silently re-files three photographs into a different report section is worth a
   * line in the record.
   */
  async reclassifyForResponse(
    scope: ScopeContext,
    responseId: string,
    value: Parameters<EvidenceRepository['reclassifyForResponse']>[2],
  ): Promise<number> {
    return this.repository.reclassifyForResponse(scope, responseId, value);
  }

  /** The §7.2 walk-by guard: "≥1 non-deleted evidence row". */
  async hasEvidenceInZone(scope: ScopeContext, auditZoneId: string): Promise<boolean> {
    return (await this.repository.countLiveEvidenceInZone(scope, auditZoneId)) > 0;
  }

  // ------------------------------------------------------------------------ helpers

  private async mustFind(scope: ScopeContext, evidenceId: string): Promise<EvidenceRow> {
    const row = await this.repository.findById(scope, evidenceId);
    if (!row) {
      throw AppError.notFound('No such evidence');
    }
    return row;
  }

  /**
   * A-2's application half plus D7's device check, in the shape `AuditZonesService` already
   * uses — so a completed audit refuses the write before the trigger has to, and with a
   * message that names the override path.
   */
  private assertWritable(
    auditStatus: string,
    scope: ScopeContext,
    owningDeviceId: string | null,
  ): void {
    if (isAuditCompleted(auditStatus)) {
      throw AppError.conflict(
        'AUDIT_ALREADY_COMPLETED',
        'This audit is completed. Use the post-completion override, which is audit-logged (A-2).',
      );
    }
    if (auditStatus === 'CANCELLED') {
      throw AppError.conflict('INVALID_STATE_TRANSITION', 'This audit was cancelled');
    }
    if (scope.actor.deviceId && owningDeviceId && owningDeviceId !== scope.actor.deviceId) {
      throw AppError.conflict(
        'DEVICE_NOT_OWNER',
        'Another device is conducting this audit. It must finish or abort it first (D7).',
      );
    }
  }

  /**
   * The Zone an intent belongs to, validated against the audit.
   *
   * A selfie has none (§5.6), and a photo naming a Zone from another audit would put an
   * image in a report for a Zone the auditor never visited.
   */
  private async resolveZone(
    scope: ScopeContext,
    request: UploadIntentRequest,
    auditId: string,
  ): Promise<string | null> {
    if (request.kind === 'AUDITOR_SELFIE') {
      return null;
    }
    if (!request.auditZoneId) {
      throw AppError.validation('This evidence must name an audit Zone', [
        { field: 'auditZoneId', message: 'Required for everything but the auditor selfie' },
      ]);
    }

    const zone = await this.repository.findZoneForEvidence(scope, request.auditZoneId);
    if (!zone || zone.auditId !== auditId) {
      throw AppError.notFound('No such audit Zone on this audit');
    }
    return zone.id;
  }

  /** The linked response for `QUESTION_EVIDENCE` (C8), validated against the audit. */
  private async resolveResponse(
    scope: ScopeContext,
    request: UploadIntentRequest,
    auditId: string,
  ): Promise<{ id: string; value: Parameters<typeof classifyEvidence>[0]['scoreAtCapture'] } | null> {
    if (request.kind !== 'QUESTION_EVIDENCE' || !request.questionResponseId) {
      return null;
    }

    const response = await this.repository.findResponseForEvidence(
      scope,
      request.questionResponseId,
    );
    if (!response || response.auditId !== auditId) {
      throw AppError.notFound('No such question response on this audit');
    }
    return { id: response.id, value: response.value };
  }
}

export function toEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    kind: row.kind,
    auditId: row.auditId,
    auditZoneId: row.auditZoneId,
    questionResponseId: row.questionResponseId,
    correctiveActionId: row.correctiveActionId,
    correctiveActionSubmissionId: row.correctiveActionSubmissionId,
    objectKey: row.objectKey,
    thumbnailObjectKey: row.thumbnailObjectKey,
    mediaProcessedAt: row.mediaProcessedAt?.toISOString() ?? null,
    storedChecksumSha256: row.storedChecksumSha256,
    contentType: row.contentType,
    byteSize: Number(row.byteSize),
    width: row.width,
    height: row.height,
    checksumSha256: row.checksumSha256,
    localDeviceId: row.localDeviceId,
    scoreAtCapture: row.scoreAtCapture,
    classification: row.classification,
    remark: row.remark,
    isSummaryFlagged: row.isSummaryFlagged,
    latitude: numberOrNull(row.latitude),
    longitude: numberOrNull(row.longitude),
    accuracyM: numberOrNull(row.accuracyM),
    locationProvider: row.locationProvider,
    capturedAt: row.capturedAt.toISOString(),
    uploadedAt: row.uploadedAt?.toISOString() ?? null,
    syncState: row.syncState,
    isLiveCapture: row.isLiveCapture,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    redactedAt: row.redactedAt?.toISOString() ?? null,
    redactionReason: row.redactionReason,
    createdAt: row.createdAt.toISOString(),
  };
}

function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}
