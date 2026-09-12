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
  exports: [CorrectiveActionsService],
})
export class CorrectiveActionsModule {}
