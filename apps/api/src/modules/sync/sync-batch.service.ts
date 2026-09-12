import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  SyncBatchItem,
  SyncBatchRequest,
  SyncBatchResponse,
  SyncBatchResult,
  SyncConflictReason,
} from '@audit5s/contracts';
import {
  commitEvidenceRequestSchema,
  completeAuditRequestSchema,
  completeAuditZoneRequestSchema,
  createAuditRequestSchema,
  patchEvidenceRequestSchema,
  pauseAuditRequestSchema,
  resumeAuditRequestSchema,
  submitCorrectiveActionRequestSchema,
  uploadIntentRequestSchema,
  upsertAuditZoneRequestSchema,
  upsertQuestionResponseRequestSchema,
} from '@audit5s/contracts';
import { sortSyncItems, type ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { CONFIG, type AppConfig } from '../../config/env';
import { AuditsService } from '../audits/audits.service';
import { AuditZonesService } from '../audit-zones/audit-zones.service';
import { CorrectiveActionsService } from '../corrective-actions/corrective-actions.service';
import { EvidenceService } from '../evidence/evidence.service';
import { ResponsesService } from '../question-responses/responses.service';
import { SyncRepository } from './sync.repository';
import { SyncEventsService } from './sync-events.service';

/**
 * `POST /sync/batch` (§8.11, §9.3) — the push path.
 *
 * Everything about this file follows from one sentence of §9.3:
 *
 * > **Per-item results are essential.** One malformed row must never block the other 99 —
 * > that is how a field team loses a day's work.
 *
 * So each item is applied on its own, inside its own `try`, and a failure produces a
 * *verdict* rather than an exception that escapes. The HTTP status is 200 whatever
 * happened inside; the interesting information is in the array.
 *
 * Three properties are load-bearing and each has a test:
 *
 *   1. **A replayed `batchId` creates nothing.** The unique index on
 *      `device_sync_record.batch_id` is claimed before any work; a device that loses the
 *      response and retries reads back the stored verdicts.
 *   2. **Items are applied in topological order** (`sortSyncItems`), and parent existence
 *      is validated rather than assumed — a missing parent is `RETRY_AFTER_PARENT`, so a
 *      device with a torn queue self-heals instead of dead-lettering good work.
 *   3. **Nothing is dropped.** Every refusal is either retryable (`RETRY_AFTER_PARENT`),
 *      already-applied (`DUPLICATE`) or quarantined with its full payload (`CONFLICT`).
 *      `REJECTED` is reserved for payloads that are malformed on their face — and even
 *      those are quarantined, because a client bug is not a reason to lose a photograph.
 *
 * AZ-5 is why this calls the same services the controllers do rather than the repositories:
 * "permission checks happen in the service layer as well as the controller for anything
 * reachable from the sync batch endpoint, which multiplexes many operations through one
 * HTTP call."
 */
@Injectable()
export class SyncBatchService {
  private readonly logger = new Logger('sync.batch');

  constructor(
    private readonly repository: SyncRepository,
    private readonly audits: AuditsService,
    private readonly zones: AuditZonesService,
    private readonly responses: ResponsesService,
    private readonly evidence: EvidenceService,
    private readonly correctiveActions: CorrectiveActionsService,
    private readonly events: SyncEventsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async apply(scope: ScopeContext, request: SyncBatchRequest): Promise<SyncBatchResponse> {
    const deviceId = this.requireDevice(scope, request.deviceId);

    // §9.3: the batchId dedupes the entire batch. Claimed *before* any item is applied,
    // on a unique index, so two concurrent copies of one batch cannot both proceed.
    const claim = await this.repository.claimBatch(scope, {
      batchId: request.batchId,
      deviceId,
      itemCount: request.items.length,
      appVersion: request.appVersion ?? null,
      networkType: request.networkType ?? null,
    });

    if (!claim.claimed) {
      return this.replay(scope, request);
    }

    const ordered = sortSyncItems(
      request.items.map((item) => ({ ...item, createdAt: undefined })),
    );

    const results: SyncBatchResult[] = [];
    // Items accepted earlier in *this* batch. A parent created a moment ago is a parent,
    // and re-reading it from the database per item would be a query per row for a fact
    // this loop already knows.
    const createdInBatch = new Set<string>();

    for (const item of ordered) {
      const result = await this.applyOne(scope, deviceId, request.batchId, item, createdInBatch);
      if (result.status === 'ACCEPTED' || result.status === 'DUPLICATE') {
        createdInBatch.add(`${item.entityType}:${item.entityId}`);
      }
      results.push(result);
    }

    const accepted = results.filter((r) => r.status === 'ACCEPTED' || r.status === 'DUPLICATE');
    const conflicts = results.filter((r) => r.status === 'CONFLICT');
    const rejected = results.filter((r) => r.status === 'REJECTED');

    await this.repository.finishBatch(scope, request.batchId, {
      results,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      conflictCount: conflicts.length,
      status: rejected.length > 0 || conflicts.length > 0 ? 'PARTIAL' : 'COMPLETED',
      error: null,
    });

    if (conflicts.length > 0 || rejected.length > 0) {
      // §7.4: `SYNC_FAILURE` is raised so somebody knows field work is sitting in a
      // quarantine. It rides pg-boss inside no domain transaction of its own — there is
      // nothing to roll back with — and the batch's own result is already committed.
      await this.events.raiseSyncFailure({
        userId: scope.actor.userId,
        deviceId,
        batchId: request.batchId,
        conflictCount: conflicts.length,
        rejectedCount: rejected.length,
      });
    }

    this.logger.log(
      `batch ${request.batchId}: ${accepted.length} accepted, ${conflicts.length} quarantined, ` +
        `${rejected.length} rejected of ${results.length}`,
    );

    return {
      batchId: request.batchId,
      serverTime: new Date().toISOString(),
      replayed: false,
      results,
    };
  }

  /**
   * A batch this server has already applied.
   *
   * The stored verdicts are returned rather than recomputed, because recomputing them
   * would mean applying the items again — and "a duplicated sync creates nothing extra"
   * is the acceptance row. A batch still in flight answers `RETRY_AFTER_PARENT` for every
   * item, which is the one verdict that asks the device to come back later without
   * marking anything failed.
   */
  private async replay(
    scope: ScopeContext,
    request: SyncBatchRequest,
  ): Promise<SyncBatchResponse> {
    const stored = await this.repository.findBatch(scope, request.batchId);

    if (stored && stored.userId !== scope.actor.userId) {
      // A batch id that belongs to somebody else is a client-generated collision or an
      // attempt to read another auditor's verdicts. Neither should be answered.
      throw AppError.conflict('CONFLICT', 'That batch id belongs to another user');
    }

    if (!stored?.finishedAt) {
      this.logger.warn(`batch ${request.batchId} is still in flight; asking the device to retry`);
      return {
        batchId: request.batchId,
        serverTime: new Date().toISOString(),
        replayed: true,
        results: request.items.map((item) => ({
          outboxId: item.outboxId,
          entityId: item.entityId,
          status: 'RETRY_AFTER_PARENT' as const,
          missingParent: 'batch:in-flight',
        })),
      };
    }

    return {
      batchId: request.batchId,
      serverTime: new Date().toISOString(),
      replayed: true,
      results: (stored.results as SyncBatchResult[] | null) ?? [],
    };
  }

  // ------------------------------------------------------------------- one item

  private async applyOne(
    scope: ScopeContext,
    deviceId: string,
    batchId: string,
    item: SyncBatchItem,
    createdInBatch: Set<string>,
  ): Promise<SyncBatchResult> {
    const base = { outboxId: item.outboxId, entityId: item.entityId };

    try {
      // Parents first: a missing one is a retry, not a failure, and must not consume an
      // attempt or quarantine work that will apply perfectly well next cycle.
      const missingParent = await this.findMissingParent(scope, item, createdInBatch);
      if (missingParent) {
        return { ...base, status: 'RETRY_AFTER_PARENT', missingParent };
      }

      const version = await this.dispatch(scope, deviceId, item);
      return { ...base, status: 'ACCEPTED', ...(version !== null ? { serverVersion: version } : {}) };
    } catch (error) {
      return this.classifyFailure(scope, deviceId, batchId, item, base, error);
    }
  }

  /**
   * Turns a thrown failure into one of §9.3's verdicts, quarantining wherever §9.5 says to.
   *
   * The mapping is from `AppError.code`, not from the HTTP status, because the codes are
   * the stable vocabulary (§8.1) and several statuses mean more than one thing.
   */
  private async classifyFailure(
    scope: ScopeContext,
    deviceId: string,
    batchId: string,
    item: SyncBatchItem,
    base: { outboxId: string; entityId: string },
    error: unknown,
  ): Promise<SyncBatchResult> {
    const code = error instanceof AppError ? error.code : null;
    const reason = QUARANTINE_REASONS[code ?? ''] ?? null;

    if (reason) {
      // §9.5's `AUDIT_ALREADY_COMPLETED` carve-out: a byte-identical late item is a
      // duplicate and is accepted silently, because the work is already on the server and
      // quarantining it would ask a Super Admin to review a no-op.
      if (reason === 'AUDIT_ALREADY_COMPLETED' && (await this.isByteIdentical(scope, item))) {
        return { ...base, status: 'DUPLICATE' };
      }

      const conflictId = await this.repository.quarantine(scope, {
        deviceId,
        entityType: item.entityType,
        entityId: item.entityId,
        reason,
        incomingPayload: item.payload,
        existingPayload: await this.snapshotExisting(scope, item),
        batchId,
      });

      this.logger.warn(
        `quarantined ${item.entityType} ${item.entityId} from device ${deviceId}: ${reason}`,
      );

      return { ...base, status: 'CONFLICT', reason, conflictId, resolution: 'QUARANTINED' };
    }

    // Everything else is a malformed or unacceptable payload. It is **still** quarantined:
    // §9.5's list includes `VALIDATION_FAILED` precisely so a client bug costs a
    // diagnosis rather than a day's field work.
    const errors = this.describe(error);
    const conflictId = await this.repository.quarantine(scope, {
      deviceId,
      entityType: item.entityType,
      entityId: item.entityId,
      reason: 'VALIDATION_FAILED',
      incomingPayload: item.payload,
      existingPayload: null,
      batchId,
    });

    this.logger.warn(
      `rejected ${item.entityType} ${item.entityId} from device ${deviceId}: ${errors.join('; ')}`,
    );

    return {
      ...base,
      status: 'REJECTED',
      reason: 'VALIDATION_FAILED',
      conflictId,
      errors,
    };
  }

  /**
   * Applies one item through the ordinary service, and returns the new server version.
   *
   * Each branch parses the payload with the **same** schema the HTTP route uses. That is
   * the point: `/sync/batch` multiplexes the API rather than shadowing it, so a rule added
   * to an endpoint is a rule the sync path gets too, with no second place to remember it.
   */
  private async dispatch(
    scope: ScopeContext,
    deviceId: string,
    item: SyncBatchItem,
  ): Promise<number | null> {
    switch (`${item.entityType}:${item.operation}`) {
      case 'audit:upsert': {
        const body = createAuditRequestSchema.parse({ ...item.payload, id: item.entityId, deviceId });
        const audit = await this.audits.create(scope, body);
        return audit.version;
      }

      case 'audit:pause': {
        const body = pauseAuditRequestSchema.parse(item.payload);
        // A device that paused offline never told the server it *started*: §9.1 has it
        // move its own audit to IN_PROGRESS locally, and the server catches up here.
        // Without this the pause arrives at an ASSIGNED audit and is refused as a
        // transition the machine does not define — losing the abort's cursors, which are
        // exactly what a replacement device needs.
        await this.ensureStarted(scope, deviceId, item.entityId);
        const audit = await this.audits.pause(scope, item.entityId, body);
        return audit.version;
      }

      case 'audit:resume': {
        const body = resumeAuditRequestSchema.parse({ ...item.payload, deviceId });
        await this.ensureStarted(scope, deviceId, item.entityId);
        // A resume also claims the lock, which is what makes it the item that surfaces
        // `DEVICE_NOT_OWNER` when a second device has taken over.
        const audit = await this.audits.resume(scope, item.entityId, body);
        return audit.version;
      }

      case 'audit:complete': {
        const body = completeAuditRequestSchema.parse(item.payload);
        // The device's own start is implicit: an audit it answered is one it started.
        await this.ensureStarted(scope, deviceId, item.entityId);
        const audit = await this.audits.complete(scope, item.entityId, body);
        return audit.version;
      }

      case 'audit_zone:upsert': {
        const body = upsertAuditZoneRequestSchema.parse(item.payload);
        const auditId = this.requireString(item.payload, 'auditId');
        await this.ensureStarted(scope, deviceId, auditId);
        const zone = await this.zones.upsert(scope, auditId, item.entityId, body);
        return zone.version;
      }

      case 'audit_zone:complete': {
        const body = completeAuditZoneRequestSchema.parse(item.payload);
        const auditId = this.requireString(item.payload, 'auditId');
        const zone = await this.zones.complete(scope, auditId, item.entityId, body);
        return zone.version;
      }

      case 'question_response:upsert': {
        const body = upsertQuestionResponseRequestSchema.parse(item.payload);
        const auditZoneId = this.requireString(item.payload, 'auditZoneId');
        await this.responses.upsert(scope, auditZoneId, item.entityId, body);
        return null;
      }

      case 'evidence:upsert': {
        const body = uploadIntentRequestSchema.parse({ ...item.payload, id: item.entityId });
        await this.evidence.createUploadIntent(scope, body);
        return null;
      }

      case 'evidence:commit': {
        const body = commitEvidenceRequestSchema.parse(item.payload);
        await this.evidence.commit(scope, item.entityId, body);
        return null;
      }

      case 'evidence:patch': {
        // The summary flag and a walk-by's classification, decided offline. `upsert`
        // cannot carry them: §8.7 makes `upload-intent` idempotent on the id and it
        // returns the existing intent untouched, which is what makes a retried upload
        // safe and what makes it unable to change anything (DECISIONS.md R-12e).
        const body = patchEvidenceRequestSchema.parse(item.payload);
        await this.evidence.patch(scope, item.entityId, body);
        return null;
      }

      case 'evidence:delete': {
        await this.evidence.softDelete(scope, item.entityId);
        return null;
      }

      case 'corrective_action_submission:submit': {
        // One attempt on one action (§7.3). The entity id is the submission id the device
        // minted, so a replay finds its own attempt instead of making attempt + 1.
        const body = submitCorrectiveActionRequestSchema.parse({ ...item.payload, id: item.entityId });
        const actionId = this.requireString(item.payload, 'correctiveActionId');
        await this.correctiveActions.submit(scope, actionId, body, 'MOBILE');
        return null;
      }

      default:
        throw AppError.validation(
          `No sync handler for ${item.entityType}:${item.operation}`,
          [{ field: 'operation', message: 'Unsupported entityType/operation pair' }],
        );
    }
  }

  /**
   * §9.3's parent validation.
   *
   * Returns `entity_type:id` of the first parent that is not there yet, or null. The
   * device re-sorts and retries; nothing is marked failed, because a torn queue is a
   * transient state and not a defect in the data.
   */
  private async findMissingParent(
    scope: ScopeContext,
    item: SyncBatchItem,
    createdInBatch: Set<string>,
  ): Promise<string | null> {
    const present = async (kind: string, id: string): Promise<boolean> => {
      if (createdInBatch.has(`${kind}:${id}`)) return true;
      switch (kind) {
        case 'audit':
          return this.repository.auditExists(scope, id);
        case 'audit_zone':
          return this.repository.auditZoneExists(scope, id);
        case 'question_response':
          return this.repository.responseExists(scope, id);
        case 'evidence':
          return this.repository.evidenceExists(scope, id);
        default:
          return true;
      }
    };

    const parents: Array<[string, string | null]> = [];

    if (item.entityType === 'audit_zone') {
      parents.push(['audit', this.optionalString(item.payload, 'auditId')]);
    }
    if (item.entityType === 'question_response') {
      parents.push(['audit_zone', this.optionalString(item.payload, 'auditZoneId')]);
    }
    if (item.entityType === 'evidence' && item.operation === 'upsert') {
      parents.push(['audit', this.optionalString(item.payload, 'auditId')]);
      parents.push(['audit_zone', this.optionalString(item.payload, 'auditZoneId')]);
      parents.push([
        'question_response',
        this.optionalString(item.payload, 'questionResponseId'),
      ]);
    }
    if (
      item.entityType === 'evidence' &&
      (item.operation === 'commit' || item.operation === 'patch')
    ) {
      // The metadata row has to exist before its object can be confirmed — this is the
      // ordering §9.3 writes as `evidence(metadata) → evidence(commit)`. A `patch` needs
      // the same row for the same reason, and a device whose queue is torn between the
      // two must be asked to come back rather than have the flag quarantined.
      parents.push(['evidence', item.entityId]);
    }
    if (item.entityType === 'corrective_action_submission') {
      // Option A cites an after-photo that rides the media queue. Until its commit has
      // landed the submission waits, rather than failing for a photo still uploading.
      const photo = this.optionalString(item.payload, 'afterEvidenceId');
      if (photo && !(await this.repository.evidenceCommitted(scope, photo))) {
        return `evidence:${photo}`;
      }
    }
    if (
      (item.entityType === 'audit' && item.operation !== 'upsert') ||
      item.entityType === 'audit_zone'
    ) {
      // A `complete` or `pause` for an audit that has not been created yet.
      if (item.entityType === 'audit') parents.push(['audit', item.entityId]);
    }

    for (const [kind, id] of parents) {
      if (!id) continue;
      if (!(await present(kind, id))) {
        return `${kind}:${id}`;
      }
    }
    return null;
  }

  /**
   * §9.5's `AUDIT_ALREADY_COMPLETED` rule: "Byte-identical → `DUPLICATE`, accepted
   * silently. Different → quarantined."
   *
   * Compared field by field against what is stored rather than by hashing the payload,
   * because the payload carries fields the row does not (client timestamps, the device's
   * own ids) and a hash would call every late item different.
   */
  private async isByteIdentical(scope: ScopeContext, item: SyncBatchItem): Promise<boolean> {
    if (item.entityType !== 'question_response') {
      // Only responses are compared today. A completion or a Zone upsert arriving late
      // carries no value to compare, so it is quarantined and a human decides.
      return false;
    }

    const stored = await this.repository.snapshotResponse(scope, item.entityId);
    if (!stored) return false;

    const incomingValue = this.optionalString(item.payload, 'value');
    const incomingRemark = this.optionalString(item.payload, 'remark');
    return stored.value === incomingValue && (stored.remark ?? null) === (incomingRemark ?? null);
  }

  /** The other side of a conflict, for the quarantine record (§5.9). */
  private async snapshotExisting(scope: ScopeContext, item: SyncBatchItem): Promise<unknown> {
    if (item.entityType === 'question_response') {
      return this.repository.snapshotResponse(scope, item.entityId);
    }
    if (item.entityType === 'evidence') {
      return this.repository.snapshotEvidence(scope, item.entityId);
    }
    return null;
  }

  /**
   * A device that has been offline never sent `start`; its first push is a batch of work.
   *
   * §9.1 is explicit that the questionnaire never issues a network request, so the device
   * moved its own audit to IN_PROGRESS locally and the server has to catch up. Failures
   * are swallowed deliberately: if the start cannot happen — another device owns it, the
   * audit is completed — the item that needed it will say so with a verdict of its own,
   * and that verdict is the one the device can act on.
   */
  private async ensureStarted(
    scope: ScopeContext,
    deviceId: string,
    auditId: string,
  ): Promise<void> {
    try {
      await this.audits.start(scope, auditId, { deviceId });
    } catch {
      // Intentionally ignored — see above.
    }
  }

  private requireDevice(scope: ScopeContext, bodyDeviceId: string): string {
    if (scope.actor.deviceId && bodyDeviceId !== scope.actor.deviceId) {
      // The token binds a device; a body claiming a different one is a red flag.
      throw AppError.forbidden('DEVICE_NOT_OWNER', 'This session is bound to another device');
    }
    return bodyDeviceId;
  }

  private optionalString(payload: Record<string, unknown>, key: string): string | null {
    const value = payload[key];
    return typeof value === 'string' ? value : null;
  }

  private requireString(payload: Record<string, unknown>, key: string): string {
    const value = this.optionalString(payload, key);
    if (!value) {
      throw AppError.validation(`This item must carry ${key}`, [
        { field: key, message: 'Required' },
      ]);
    }
    return value;
  }

  /** A human-readable reason, for the verdict and for the log. */
  private describe(error: unknown): string[] {
    if (error instanceof AppError) {
      const fields = error.fieldErrors?.map((e) => `${e.field}: ${e.message}`) ?? [];
      return fields.length > 0 ? fields : [error.detail ?? error.title];
    }
    if (error && typeof error === 'object' && 'issues' in error) {
      // A Zod failure from one of the shared schemas.
      const issues = (error as { issues: Array<{ path: unknown[]; message: string }> }).issues;
      return issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    return [error instanceof Error ? error.message : 'Unknown error'];
  }

  /** The grace period a paused audit's device lock survives (§9.5 Layer 1). */
  get deviceReleaseGraceHours(): number {
    return this.config.DEVICE_RELEASE_GRACE_HOURS;
  }
}

/**
 * Error code → §9.5 quarantine reason.
 *
 * A code that is not here is not a conflict: it is a malformed payload, and it lands in
 * the quarantine as `VALIDATION_FAILED` rather than being silently retried forever.
 */
const QUARANTINE_REASONS: Record<string, SyncConflictReason> = {
  AUDIT_ALREADY_COMPLETED: 'AUDIT_ALREADY_COMPLETED',
  DEVICE_NOT_OWNER: 'DEVICE_NOT_OWNER',
  CHECKLIST_VERSION_MISMATCH: 'CHECKLIST_VERSION_MISMATCH',
  SCOPE_REVOKED: 'SCOPE_REVOKED',
  NOT_FOUND: 'SCOPE_REVOKED',
  FORBIDDEN: 'SCOPE_REVOKED',
};
