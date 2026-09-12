import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type {
  GenerateReportRequest,
  ListReportsQuery,
  Page,
  ReportDownloadUrl,
  ReportKind,
  ReportPayload,
  ReportSnapshot,
} from '@audit5s/contracts';
import { isAuditCompleted, type ScopeContext } from '@audit5s/domain';
import type { Transaction } from '@audit5s/db';
import { AppError } from '../../common/errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { isUniqueViolation } from '../../common/pg-errors';
import { CONFIG, type AppConfig } from '../../config/env';
import { DomainEvents } from '../../infrastructure/queue/domain-events';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { freezePayload } from './report-payload';
import { ReportTokensService } from './report-tokens.service';
import { ReportsRepository, type ReportSnapshotRow } from './reports.repository';
import { TEMPLATE_VERSION } from './templates/version';

/** The render job's payload. Small on purpose: the snapshot carries everything else. */
export interface ReportRenderJob {
  snapshotId: string;
  requestedByUserId: string;
}

const KIND_LABEL: Record<ReportKind, string> = {
  INITIAL_ZONE: 'Initial Zone Report',
  AFTER_EVIDENCE_ZONE: 'After-Evidence Report',
  MULTI_ZONE_SUMMARY: 'Summary Report',
};

/**
 * Reports (§8.9, PART 10).
 *
 * Two rules shape everything here.
 *
 * **Never render inside an HTTP request** (STACK.md §5). `generate` freezes a payload and
 * returns `202`; a headless Chromium started on the request path would put a 1.5 GB
 * process behind a user's Generate button on a 12 GB box, which is how Postgres gets
 * OOM-killed.
 *
 * **Regeneration creates a version; nothing overwrites** (RS-1). `regenerate` is the same
 * code path as `generate` with the previous snapshot recorded as superseded, and v1 stays
 * exactly as it was issued — which is what an external certification body asking "what did
 * you send us in September" needs.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly repository: ReportsRepository,
    private readonly tokens: ReportTokensService,
    private readonly storage: ObjectStorage,
    private readonly queue: QueueService,
    private readonly events: DomainEvents,
    private readonly auditLog: AuditLogService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------------ generate

  async generate(scope: ScopeContext, request: GenerateReportRequest): Promise<ReportSnapshot> {
    const snapshotId = uuidv7();

    const row = await this.freezeAndQueue(scope, request, snapshotId, null);

    await this.auditLog.record({
      action: 'report.generated',
      resourceType: 'report',
      resourceId: snapshotId,
      unitId: row.unitId,
      after: { kind: row.kind, version: row.version },
    });

    return toContract(row);
  }

  /**
   * `POST /reports/{snapshotId}/regenerate` — version + 1, the original untouched.
   *
   * The kind and the target come from the snapshot being regenerated rather than from the
   * request, so "regenerate" cannot quietly become "generate something else with a version
   * number that suggests continuity".
   */
  async regenerate(scope: ScopeContext, snapshotId: string): Promise<ReportSnapshot> {
    const previous = await this.mustFind(scope, snapshotId);
    const request: GenerateReportRequest =
      previous.kind === 'MULTI_ZONE_SUMMARY'
        ? {
            kind: 'MULTI_ZONE_SUMMARY',
            unitId: previous.unitId,
            selectedZoneIds: previous.selectedZoneIds ?? [],
          }
        : { kind: previous.kind, auditZoneId: previous.auditZoneId! };

    const newId = uuidv7();
    const row = await this.freezeAndQueue(scope, request, newId, previous.id);

    await this.auditLog.record({
      action: 'report.generated',
      resourceType: 'report',
      resourceId: newId,
      unitId: row.unitId,
      before: { supersedes: previous.id, version: previous.version },
      after: { kind: row.kind, version: row.version },
    });

    return toContract(row);
  }

  /**
   * The freeze, the token minting, the insert and the enqueue — **one transaction**.
   *
   * All four or none. A snapshot with no job never renders and looks like a hung report; a
   * job with no snapshot dead-letters on a missing row. pg-boss enqueues on this very
   * transaction (R-2), which is the whole reason it is the queue.
   */
  private async freezeAndQueue(
    scope: ScopeContext,
    request: GenerateReportRequest,
    snapshotId: string,
    supersedes: string | null,
  ): Promise<ReportSnapshotRow> {
    try {
      return await this.repository.inTransaction(scope, async (tx) => {
        const target = await this.resolveTarget(tx, request);
        const { version, supersedesSnapshotId } = await this.repository.nextVersion(tx, {
          auditZoneId: target.auditZoneId,
          unitId: target.unitId,
          kind: request.kind,
        });

        const payload = await this.freeze(tx, scope, {
          ...target,
          kind: request.kind,
          snapshotId,
          version,
        });

        await this.repository.insertSnapshot(tx, {
          id: snapshotId,
          kind: request.kind,
          version,
          supersedesSnapshotId: supersedes ?? supersedesSnapshotId,
          unitId: target.unitId,
          auditId: target.auditId,
          auditZoneId: target.auditZoneId,
          selectedZoneIds: request.kind === 'MULTI_ZONE_SUMMARY' ? request.selectedZoneIds : null,
          payload,
          payloadSchemaVersion: payload.schemaVersion,
          templateVersion: TEMPLATE_VERSION,
          status: 'QUEUED',
          generatedByUserId: scope.actor.userId,
          generatedAt: new Date(payload.generatedAt),
        });

        await this.queue.sendInTransaction(
          tx,
          QUEUES.reportRender,
          { snapshotId, requestedByUserId: scope.actor.userId } satisfies ReportRenderJob,
          // STACK.md §5: "120s job timeout, one retry, then a visible dead-letter."
          { retryLimit: 1, expireInSeconds: Math.ceil(this.config.REPORT_RENDER_TIMEOUT_MS / 1000) },
        );

        return {
          id: snapshotId,
          kind: request.kind,
          version,
          supersedesSnapshotId: supersedes ?? supersedesSnapshotId,
          unitId: target.unitId,
          auditId: target.auditId,
          auditZoneId: target.auditZoneId,
          selectedZoneIds: request.kind === 'MULTI_ZONE_SUMMARY' ? request.selectedZoneIds : null,
          payload,
          payloadSchemaVersion: payload.schemaVersion,
          templateVersion: TEMPLATE_VERSION,
          status: 'QUEUED' as const,
          pdfObjectKey: null,
          pdfChecksumSha256: null,
          pageCount: null,
          generatedByUserId: scope.actor.userId,
          generatedByName: payload.generatedByName,
          generatedAt: new Date(payload.generatedAt),
          renderedAt: null,
          failedReason: null,
          createdAt: new Date(payload.generatedAt),
          updatedAt: new Date(payload.generatedAt),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'report_snapshot_zone_version_key')) {
        throw AppError.conflict(
          'VERSION_CONFLICT',
          'Another report for this Zone was generated a moment ago. Reload the version history.',
        );
      }
      throw error;
    }
  }

  /** Validates the request against §10.2's first line and resolves what to freeze. */
  private async resolveTarget(
    tx: Transaction,
    request: GenerateReportRequest,
  ): Promise<{ unitId: string; auditId: string | null; auditZoneId: string | null; auditZoneIds: string[] }> {
    if (request.kind === 'MULTI_ZONE_SUMMARY') {
      const auditZoneIds = await this.repository.resolveLatestAuditZones(
        tx,
        request.unitId,
        request.selectedZoneIds,
      );
      if (auditZoneIds.length === 0) {
        throw AppError.validation('None of the selected Zones has a completed audit', [
          { field: 'selectedZoneIds', message: 'No completed audit in any selected Zone' },
        ]);
      }
      return { unitId: request.unitId, auditId: null, auditZoneId: null, auditZoneIds };
    }

    const [zone] = await this.repository.readZones(tx, [request.auditZoneId]);
    if (!zone) throw AppError.notFound('No such audit Zone');

    // §10.2: "validate: audit COMPLETED or later". A report of work still in progress
    // would be a document asserting a score that is still moving.
    const status = await this.repository.readAuditStatus(tx, zone.auditId);
    if (!status || !isAuditCompleted(status)) {
      throw AppError.conflict(
        'CONFLICT',
        'This audit is not completed. A report is generated from a finished audit.',
      );
    }

    return {
      unitId: zone.unitId,
      auditId: zone.auditId,
      auditZoneId: zone.auditZoneId,
      auditZoneIds: [zone.auditZoneId],
    };
  }

  /** Reads everything the document prints, at one instant, and mints its links. */
  private async freeze(
    tx: Transaction,
    scope: ScopeContext,
    target: {
      kind: ReportKind;
      snapshotId: string;
      version: number;
      unitId: string;
      auditId: string | null;
      auditZoneIds: string[];
      /** False for a preview: a preview must not be a way to issue live links. */
      mintTokens?: boolean;
    },
  ): Promise<ReportPayload> {
    const unit = await this.repository.readUnit(tx, target.unitId);
    if (!unit) throw AppError.notFound('No such Unit');

    const [zones, sectionScores, responses, photos, actions, generatedByName] = await Promise.all([
      this.repository.readZones(tx, target.auditZoneIds),
      this.repository.readSectionScores(tx, target.auditZoneIds),
      this.repository.readResponses(tx, target.auditZoneIds),
      this.repository.readPhotos(tx, target.auditZoneIds),
      this.repository.readCorrectiveActions(tx, target.auditZoneIds),
      this.repository.readUserName(tx, scope.actor.userId),
    ]);

    const selfieObjectKey =
      target.kind === 'MULTI_ZONE_SUMMARY' || !target.auditId
        ? null
        : await this.repository.readSelfieKey(tx, target.auditId);

    // A verified finding needs no button: the right half of its row already carries the
    // outcome. Minting a link for it would put a live door on a closed item.
    const actionUrls =
      target.mintTokens === false
        ? new Map<string, string>()
        : await this.tokens.mintForSnapshot(tx, {
            snapshotId: target.snapshotId,
            unitId: target.unitId,
            createdByUserId: scope.actor.userId,
            actions: actions
              .filter((action) => action.status !== 'VERIFIED')
              .map((action) => ({
                id: action.id,
                assignedZoneLeaderUserId: action.assignedZoneLeaderUserId,
              })),
          });

    return freezePayload({
      kind: target.kind,
      snapshotId: target.snapshotId,
      version: target.version,
      // Frozen here, once. The renderer never calls `new Date()`, which is half of what
      // makes the same payload produce the same bytes.
      generatedAt: new Date(),
      generatedByName,
      unit,
      zones,
      sectionScores,
      responses,
      photos,
      actions,
      selfieObjectKey,
      actionUrls,
    });
  }

  /**
   * `POST /reports/preview` — HTML for template iteration, **no PDF and no snapshot**.
   *
   * It runs the same freeze as `generate` and then rolls the transaction back, so what a
   * designer looks at is the real payload rather than a second, simpler code path that
   * could agree with the renderer today and not tomorrow. No token is minted: a preview
   * that handed out live links would be a way to issue links without issuing a report.
   */
  async preview(scope: ScopeContext, request: GenerateReportRequest): Promise<ReportPayload> {
    const snapshotId = uuidv7();
    return this.repository.inTransaction(scope, async (tx) => {
      const target = await this.resolveTarget(tx, request);
      const payload = await this.freeze(tx, scope, {
        ...target,
        kind: request.kind,
        snapshotId,
        version: 0,
        mintTokens: false,
      });
      // Nothing was written, but the freeze read under a transaction and the caller gets
      // the payload rather than a row. Rolling back keeps that literally true.
      await tx.rollback();
      return payload;
    });
  }

  // ---------------------------------------------------------------------------- reads

  async get(scope: ScopeContext, snapshotId: string): Promise<ReportSnapshot> {
    return toContract(await this.mustFind(scope, snapshotId));
  }

  async list(scope: ScopeContext, query: ListReportsQuery): Promise<Page<ReportSnapshot>> {
    const rows = await this.repository.list(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toContract), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  /** The PDF itself never transits the API: a short-TTL presigned GET, minted after scope. */
  async downloadUrl(scope: ScopeContext, snapshotId: string): Promise<ReportDownloadUrl> {
    const snapshot = await this.mustFind(scope, snapshotId);
    if (snapshot.status !== 'READY' || !snapshot.pdfObjectKey) {
      throw AppError.conflict(
        'CONFLICT',
        snapshot.status === 'FAILED'
          ? `This report failed to render: ${snapshot.failedReason ?? 'unknown reason'}`
          : 'This report is still rendering. It will be ready shortly.',
      );
    }

    const download = await this.storage.presignGet(snapshot.pdfObjectKey, {
      expiresInSeconds: this.config.REPORT_GET_URL_TTL_SECONDS,
    });
    return {
      url: download.url,
      expiresIn: download.expiresIn,
      checksumSha256: snapshot.pdfChecksumSha256,
    };
  }

  /** The frozen payload, for the on-screen preview and for the renderer. */
  async payload(scope: ScopeContext, snapshotId: string): Promise<ReportPayload> {
    return (await this.mustFind(scope, snapshotId)).payload;
  }

  // ------------------------------------------------------------- the worker's callbacks

  async markRendering(scope: ScopeContext, snapshotId: string): Promise<boolean> {
    return this.repository.markStatus(scope, snapshotId, ['QUEUED', 'RENDERING'], {
      status: 'RENDERING',
    });
  }

  async markReady(
    scope: ScopeContext,
    snapshot: ReportSnapshotRow,
    result: { objectKey: string; checksumSha256: string; pageCount: number | null },
  ): Promise<void> {
    await this.repository.markStatus(scope, snapshot.id, ['QUEUED', 'RENDERING'], {
      status: 'READY',
      pdfObjectKey: result.objectKey,
      pdfChecksumSha256: result.checksumSha256,
      pageCount: result.pageCount,
      renderedAt: new Date(),
    });

    // The event rides its own transaction: the render already committed, and a failure to
    // tell people about a finished report must not un-finish it.
    await this.repository.inTransaction(scope, async (tx) => {
      await this.events.emit(tx, {
        type: 'REPORT_GENERATED',
        actorUserId: snapshot.generatedByUserId,
        unitId: snapshot.unitId,
        resourceType: 'report',
        resourceId: snapshot.id,
        data: {
          kind: snapshot.kind,
          kindLabel: KIND_LABEL[snapshot.kind],
          version: snapshot.version,
          zoneCode: snapshot.payload.zones[0]?.zoneCode ?? null,
          zoneName: snapshot.payload.zones[0]?.zoneName ?? null,
        },
      });
    });
  }

  async markFailed(scope: ScopeContext, snapshotId: string, reason: string): Promise<void> {
    await this.repository.markStatus(scope, snapshotId, ['QUEUED', 'RENDERING'], {
      status: 'FAILED',
      failedReason: reason.slice(0, 2000),
    });
    this.logger.error(`report ${snapshotId} failed to render: ${reason}`);
  }

  async findForWorker(scope: ScopeContext, snapshotId: string): Promise<ReportSnapshotRow> {
    return this.mustFind(scope, snapshotId);
  }

  private async mustFind(scope: ScopeContext, snapshotId: string): Promise<ReportSnapshotRow> {
    const row = await this.repository.findById(scope, snapshotId);
    if (!row) throw AppError.notFound('No such report');
    return row;
  }
}

/** `report/{unit_id}/{snapshot_id}/v{n}.pdf` (§10.2). Stable, so a re-upload overwrites. */
export function reportObjectKey(unitId: string, snapshotId: string, version: number): string {
  return `report/${unitId}/${snapshotId}/v${version}.pdf`;
}

export function toContract(row: ReportSnapshotRow): ReportSnapshot {
  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    supersedesSnapshotId: row.supersedesSnapshotId,
    unitId: row.unitId,
    auditId: row.auditId,
    auditZoneId: row.auditZoneId,
    selectedZoneIds: row.selectedZoneIds,
    payloadSchemaVersion: row.payloadSchemaVersion,
    templateVersion: row.templateVersion,
    status: row.status,
    pdfObjectKey: row.pdfObjectKey,
    pdfChecksumSha256: row.pdfChecksumSha256,
    pageCount: row.pageCount,
    generatedByUserId: row.generatedByUserId,
    generatedByName: row.generatedByName,
    generatedAt: row.generatedAt.toISOString(),
    renderedAt: row.renderedAt?.toISOString() ?? null,
    failedReason: row.failedReason,
  };
}
