import { Injectable, Logger } from '@nestjs/common';
import { grantFor, type ScopeContext } from '@audit5s/domain';
import { ActorRepository } from '../../common/auth/actor.repository';
import { QUEUES, QueueService } from '../../infrastructure/queue/queue.service';
import { ObjectStorage } from '../../infrastructure/storage/object-storage';
import { ReportRenderer } from './report-renderer';
import { ReportsService, reportObjectKey, type ReportRenderJob } from './reports.service';

/**
 * `report.render`, run by `worker-report` and by nothing else (STACK.md §4/§5).
 *
 * The job is deliberately tiny — a snapshot id and who asked — because the payload is
 * already frozen in the row. Passing the payload through the queue would let a job and its
 * snapshot disagree, which is precisely what freezing exists to prevent.
 *
 * **Identity travels; authority does not**, the rule the import and media workers
 * established. The Super Admin who pressed Generate is named on the job, but their role
 * and their account's standing are re-read here: a Super Admin disabled between the
 * request and the render does not have a document produced on their behalf under
 * yesterday's grant. It has to travel at all because `report_snapshot` sits behind an RLS
 * policy keyed on `app_is_super_admin()` and there is no system bypass by design.
 *
 * Failure is **visible**, never silent. A render that cannot be completed marks the
 * snapshot `FAILED` with its reason, which is what the version history shows and what the
 * download route quotes back — so a report that did not arrive looks like a failed report
 * rather than one that is still, permanently, "rendering".
 */
@Injectable()
export class ReportWorker {
  private readonly logger = new Logger(ReportWorker.name);

  constructor(
    private readonly reports: ReportsService,
    private readonly renderer: ReportRenderer,
    private readonly storage: ObjectStorage,
    private readonly actors: ActorRepository,
  ) {}

  /** Registers the handler. Called by the `worker-report` entrypoint. */
  async register(queue: QueueService): Promise<void> {
    await queue.work<ReportRenderJob>(
      QUEUES.reportRender,
      async (jobs) => {
        for (const job of jobs) {
          await this.handle(job.data);
        }
      },
      // Concurrency 1: a second headless Chromium on an 8 GB box is how Postgres gets
      // OOM-killed (STACK.md §5).
      { batchSize: 1 },
    );
  }

  async handle(data: ReportRenderJob): Promise<void> {
    const scope = await this.scopeFor(data.requestedByUserId);
    if (!scope) {
      // Thrown rather than swallowed: pg-boss retries once and then dead-letters it where
      // a person can see it. Marking the snapshot FAILED would need the very actor that is
      // missing, so the visible failure is the dead letter.
      throw new Error(
        `report.render ${data.snapshotId}: the requesting Super Admin ` +
          `(${data.requestedByUserId}) is no longer usable, so nothing was rendered.`,
      );
    }

    const snapshot = await this.reports.findForWorker(scope, data.snapshotId);

    if (snapshot.status === 'READY') {
      // pg-boss makes no at-most-once promise. A redelivered job for a finished report is
      // a no-op, not a second render — and RS-1's trigger would refuse the write anyway.
      this.logger.log(`${data.snapshotId}: already READY; redelivered job ignored`);
      return;
    }

    await this.reports.markRendering(scope, data.snapshotId);

    try {
      const rendered = await this.renderer.render(snapshot.payload);
      const key = reportObjectKey(snapshot.unitId, snapshot.id, snapshot.version);

      // The object first, the row second. A row pointing at an object that is not there
      // would be a download that 404s; an object no row points at is 40 kB of garbage a
      // lifecycle rule collects. Only one of those is visible to a user.
      await this.storage.put(key, rendered.pdf, 'application/pdf');

      await this.reports.markReady(scope, snapshot, {
        objectKey: key,
        checksumSha256: rendered.checksumSha256,
        pageCount: rendered.pageCount,
      });

      this.logger.log(
        `${data.snapshotId}: rendered v${snapshot.version} (${rendered.pdf.byteLength} bytes, ` +
          `${rendered.pageCount ?? '?'} pages)`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.reports.markFailed(scope, data.snapshotId, reason);
      // Rethrown so the retry STACK.md §5 asks for actually happens. The second failure
      // dead-letters, and the snapshot already says FAILED either way.
      throw error;
    }
  }

  /**
   * The job's actor, re-derived (AZ-5).
   *
   * `report:generate` is the cell being exercised — the worker is finishing the act the
   * request began — so a role that has lost it produces no scope and no render.
   */
  private async scopeFor(userId: string): Promise<ScopeContext | null> {
    const record = await this.actors.loadActor(userId, null);
    if (!record || !ActorRepository.isUsable(record)) return null;

    const grant = grantFor(record.actor.role, 'report:generate');
    if (!grant) return null;

    return {
      actor: record.actor,
      resolver: grant.resolver,
      ...(grant.condition ? { condition: grant.condition } : {}),
    };
  }
}
