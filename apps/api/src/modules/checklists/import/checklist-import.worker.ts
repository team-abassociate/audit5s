import { Injectable, Logger } from '@nestjs/common';
import { grantFor, type ScopeContext } from '@audit5s/domain';
import { ActorRepository } from '../../../common/auth/actor.repository';
import { QUEUES, QueueService } from '../../../infrastructure/queue/queue.service';
import { ChecklistImportService } from './checklist-import.service';

export interface ChecklistImportJobData {
  jobId: string;
  /**
   * Who asked for the parse.
   *
   * The *identity* travels with the job; the *authority* does not. Nothing here trusts
   * the payload beyond "look this user up" — the role, the scope and the grant are all
   * re-read from the database when the job runs, so a Super Admin disabled between upload
   * and parse cannot have their job execute under yesterday's authority.
   *
   * It has to travel, because the worker has no actor yet and `checklist_import_job` is
   * behind an RLS policy that admits Super Admins only: without a user to become, the
   * worker cannot so much as read the row that would tell it whose job this is.
   */
  uploadedByUserId: string;
}

/**
 * The `checklist.import` handler, run by `worker-general` (STACK.md §7 step 6).
 *
 * It is a thin wrapper: every rule lives in `ChecklistImportService.runPipeline`, which
 * the seed calls directly too. One implementation of the import, two callers — which is
 * what makes the seed a genuine integration test of the importer rather than a parallel
 * one that could pass while the real path is broken.
 */
@Injectable()
export class ChecklistImportWorker {
  private readonly logger = new Logger('checklist.import');

  constructor(
    private readonly imports: ChecklistImportService,
    private readonly actors: ActorRepository,
  ) {}

  /** Registers the handler. Called by the `worker-general` entrypoint. */
  async register(queue: QueueService): Promise<void> {
    await queue.work<ChecklistImportJobData>(QUEUES.checklistImport, async (jobs) => {
      for (const job of jobs) {
        await this.handle(job.data);
      }
    });
  }

  async handle(data: ChecklistImportJobData): Promise<void> {
    const scope = await this.scopeFor(data.uploadedByUserId);
    if (!scope) {
      // Thrown rather than swallowed: the job has not been validated and saying so is the
      // honest outcome. pg-boss retries and then dead-letters it, which is visible;
      // quietly marking the row FAILED would need a write this worker has no authority to
      // make, and pretending otherwise is how a stuck import becomes invisible.
      throw new Error(
        `checklist import ${data.jobId}: the uploader (${data.uploadedByUserId}) is no longer ` +
          'an active Super Admin, so this workbook cannot be parsed on their behalf',
      );
    }

    this.logger.log(`job ${data.jobId}: parsing`);
    await this.imports.runPipeline(scope, data.jobId);
    this.logger.log(`job ${data.jobId}: parsed`);
  }

  /**
   * The scope the pipeline runs under: the uploader's own, with the resolver PART 6
   * grants their role — read from the matrix exactly as `ScopeGuard` reads it in a
   * request. AZ-5 in practice: the path that does not go through a controller applies the
   * same checks as the one that does.
   */
  private async scopeFor(userId: string): Promise<ScopeContext | null> {
    const record = await this.actors.loadActor(userId, null);
    if (!record || !ActorRepository.isUsable(record)) return null;

    const grant = grantFor(record.actor.role, 'checklist_import:preview');
    if (!grant) return null;

    return {
      actor: record.actor,
      resolver: grant.resolver,
      ...(grant.condition ? { condition: grant.condition } : {}),
    };
  }
}
