import { Module } from '@nestjs/common';
import { CorrectiveActionsController } from './corrective-actions.controller';
import { CorrectiveActionsRepository } from './corrective-actions.repository';
import { CorrectiveActionsService } from './corrective-actions.service';

/**
 * Corrective actions (§2.8, §7.3, §8.8).
 *
 * Imports nothing of the audit engine: `audits` calls in to materialise on completion,
 * `evidence` to scope an after-photo, `sync` to apply a submission and fill the catalogue.
 * The dependency runs one way, so there is no cycle to design around.
 */
@Module({
  controllers: [CorrectiveActionsController],
  providers: [CorrectiveActionsService, CorrectiveActionsRepository],
  // The repository is exported alongside the service for the public corrective-action
  // surface (Phase 7), which needs two reads the service does not expose — the before
  // photo's evidence id and the Unit/auditor names the page prints. Both go through the
  // same scope predicate, so this widens nothing.
  exports: [CorrectiveActionsService, CorrectiveActionsRepository],
})
export class CorrectiveActionsModule {}
