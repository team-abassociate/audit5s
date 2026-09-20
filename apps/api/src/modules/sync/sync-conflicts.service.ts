import { Injectable, Logger } from '@nestjs/common';
import type {
  ListSyncConflictsQuery,
  Page,
  ResolveSyncConflictRequest,
  SyncConflict,
  SyncConflictReason,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { AuditsService } from '../audits/audits.service';
import { SyncRepository, type SyncConflictRow } from './sync.repository';

/**
 * The quarantine, read and resolved (§8.10, §9.5 Layer 3).
 *
 * Two rules govern this file and both are about not losing things:
 *
 *   - **`APPLY` routes through the post-completion override.** §8.10 says so explicitly,
 *     and the reason is that applying a quarantined answer to a completed audit is exactly
 *     the change A-2 exists to make traceable. Going straight to the table would work and
 *     would leave no trail, which is the outcome the invariant was written to prevent.
 *   - **`DISCARD` keeps the payload.** Nothing here clears `incoming_payload`, and the
 *     table refuses a DELETE. Discarding is a decision about what to act on.
 */
@Injectable()
export class SyncConflictsService {
  private readonly logger = new Logger('sync.conflicts');

  constructor(
    private readonly repository: SyncRepository,
    private readonly audits: AuditsService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(scope: ScopeContext, query: ListSyncConflictsQuery): Promise<Page<SyncConflict>> {
    const rows = await this.repository.listConflicts(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toSyncConflict), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  async get(scope: ScopeContext, conflictId: string): Promise<SyncConflict> {
    return toSyncConflict(await this.mustFind(scope, conflictId));
  }

  async resolve(
    scope: ScopeContext,
    conflictId: string,
    request: ResolveSyncConflictRequest,
  ): Promise<SyncConflict> {
    const conflict = await this.mustFind(scope, conflictId);

    if (conflict.resolvedAt) {
      throw AppError.conflict(
        'CONFLICT_ALREADY_RESOLVED',
        `This conflict was already resolved as ${conflict.resolution}`,
      );
    }

    if (request.resolution === 'APPLY') {
      await this.applyThroughOverride(scope, conflict, request.note);
    }

    await this.repository.resolveConflict(scope, conflictId, {
      resolution: request.resolution,
      note: request.note,
    });

    await this.auditLog.record({
      action: 'sync_conflict.resolved',
      resourceType: 'sync_conflict',
      resourceId: conflictId,
      before: { reason: conflict.reason, resolvedAt: null },
      // The resolution is in the payload rather than in the action name: the vocabulary
      // of §5.9 has one `sync_conflict.resolved`, and a reader filtering the log for it
      // should find every resolution rather than half of them.
      after: { resolution: request.resolution, note: request.note },
    });

    this.logger.log(`conflict ${conflictId} resolved as ${request.resolution}`);
    return this.get(scope, conflictId);
  }

  /**
   * `APPLY`, through the one door §8.10 names.
   *
   * Only a `question_response` conflict can be applied automatically, and that is stated
   * rather than worked around: the override endpoint's shape is a list of response
   * changes, and inventing a path for a Zone completion or an evidence commit would mean
   * inventing an override the architecture has not defined. Everything else is surfaced
   * with its payload so a Super Admin can act on it deliberately.
   */
  private async applyThroughOverride(
    scope: ScopeContext,
    conflict: SyncConflictRow,
    note: string,
  ): Promise<void> {
    if (conflict.entityType !== 'question_response') {
      throw AppError.conflict(
        'CONFLICT',
        `A ${conflict.entityType} conflict cannot be applied automatically. Its payload is ` +
          'here in full; make the change through the audit and record why.',
      );
    }

    const payload = conflict.incomingPayload as Record<string, unknown>;
    const value = payload.value;
    if (typeof value !== 'string') {
      throw AppError.validation('That quarantined payload carries no response value', [
        { field: 'incomingPayload.value', message: 'Missing' },
      ]);
    }

    const existing = conflict.existingPayload as { id?: string } | null;
    const responseId = existing?.id ?? conflict.entityId;

    const auditId = await this.repository.auditIdForResponse(scope, responseId);
    if (!auditId) {
      throw AppError.notFound('The response this conflict refers to no longer exists');
    }

    // The same endpoint a Super Admin would use by hand, so the `AuditLog` entry with
    // before and after is written by the same code path and cannot be skipped here.
    await this.audits.postCompletionOverride(scope, auditId, {
      justification: `Applied from sync conflict ${conflict.id}: ${note}`,
      changes: {
        responses: [
          {
            responseId,
            value: value as 'SCORE_2' | 'SCORE_1' | 'SCORE_0' | 'NA',
            remark: typeof payload.remark === 'string' ? payload.remark : null,
          },
        ],
      },
    });
  }

  private async mustFind(scope: ScopeContext, conflictId: string): Promise<SyncConflictRow> {
    const conflict = await this.repository.findConflict(scope, conflictId);
    if (!conflict) {
      throw AppError.notFound('No such sync conflict');
    }
    return conflict;
  }
}

export function toSyncConflict(row: SyncConflictRow): SyncConflict {
  return {
    id: row.id,
    deviceId: row.deviceId,
    userId: row.userId,
    userName: row.userName,
    entityType: row.entityType,
    entityId: row.entityId,
    reason: row.reason as SyncConflictReason,
    detail: row.detail,
    incomingPayload: (row.incomingPayload ?? {}) as Record<string, unknown>,
    existingPayload: (row.existingPayload ?? null) as Record<string, unknown> | null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByUserId: row.resolvedByUserId,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
  };
}
