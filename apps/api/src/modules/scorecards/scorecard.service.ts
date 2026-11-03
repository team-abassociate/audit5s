import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ScorecardExport } from '@audit5s/contracts';
import { isScoredAuditType, type ScopeContext } from '@audit5s/domain';
import { scopeFor } from '../../common/auth/scope-for';
import { AppError } from '../../common/errors';
import { CONFIG, type AppConfig } from '../../config/env';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { AuditsService } from '../audits/audits.service';
import { ReportRenderer } from '../reports/report-renderer';
import { renderScorecardHtml, scorecardFileName } from './scorecard-html';

export interface ScorecardJobData {
  auditId: string;
  exportId: string;
  /** Who asked. Identity, never authority: the worker re-reads the grant. */
  userId: string;
}

/**
 * R-80: an audit's score card as a PDF, for its auditor and whoever reads its score summary
 * (`report:score_summary`). Queued, printed by `worker-report`, polled — the Kaizen Sheet's
 * pattern, so there is no export table: the job id is the export id.
 */
@Injectable()
export class ScorecardService {
  private readonly logger = new Logger(ScorecardService.name);

  constructor(
    private readonly audits: AuditsService,
    private readonly storage: ObjectStorage,
    private readonly queue: QueueService,
    private readonly renderer: ReportRenderer,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async request(scope: ScopeContext, auditId: string): Promise<ScorecardExport> {
    const { audit, summary } = await this.read(scope, auditId);
    if (!isScoredAuditType(audit.auditType)) {
      throw AppError.validation('A walk-by has no score card', [{ field: 'auditId', message: 'Not a scored audit' }]);
    }
    const exportId = randomUUID();
    const job: ScorecardJobData = { auditId, exportId, userId: scope.actor.userId };
    await this.queue.send(QUEUES.scorecardExport, job, { id: exportId });
    return { exportId, status: 'QUEUED', fileName: scorecardFileName(audit, summary), downloadUrl: null, expiresIn: null };
  }

  async status(scope: ScopeContext, auditId: string, exportId: string): Promise<ScorecardExport> {
    const { audit, summary } = await this.read(scope, auditId);
    const fileName = scorecardFileName(audit, summary);
    const key = exportKey(audit.unitId, auditId, exportId);
    if (await this.storage.head(key)) {
      const download = await this.storage.presignGet(key, { expiresInSeconds: this.config.REPORT_GET_URL_TTL_SECONDS });
      return { exportId, status: 'READY', fileName, downloadUrl: download.url, expiresIn: download.expiresIn };
    }
    const job = await this.queue.findJob<ScorecardJobData>(QUEUES.scorecardExport, exportId);
    // Another audit's export id reads as absent, like another Unit's audit.
    if (!job || job.data.auditId !== auditId) throw AppError.notFound('No such export');
    const failed = job.state === 'failed' || job.state === 'cancelled';
    return { exportId, status: failed ? 'FAILED' : 'QUEUED', fileName, downloadUrl: null, expiresIn: null };
  }

  /** The worker's half: print the card and store it where `status` looks. */
  async write(scope: ScopeContext, auditId: string, exportId: string): Promise<void> {
    const { audit, summary } = await this.read(scope, auditId);
    const pdf = await this.renderer.printToPdf(renderScorecardHtml(audit, summary));
    await this.storage.put(exportKey(audit.unitId, auditId, exportId), pdf, 'application/pdf');
    this.logger.log(`${auditId}: score card exported (${pdf.byteLength} bytes)`);
  }

  private async read(scope: ScopeContext, auditId: string) {
    const read = scopeFor(scope, 'report:score_summary');
    return { audit: await this.audits.get(read, auditId), summary: await this.audits.summary(read, auditId) };
  }
}

function exportKey(unitId: string, auditId: string, exportId: string): string {
  return `scorecard/${unitId}/${auditId}/${exportId}.pdf`;
}
