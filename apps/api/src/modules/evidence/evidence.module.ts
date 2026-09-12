import { Module } from '@nestjs/common';
import { CorrectiveActionsModule } from '../corrective-actions/corrective-actions.module';
import {
  AuditEvidenceController,
  AuditZoneEvidenceController,
  EvidenceController,
} from './evidence.controller';
import { EvidenceRepository } from './evidence.repository';
import { EvidenceService } from './evidence.service';
import { MediaWorker } from './media.worker';

/**
 * Evidence (§5.6, §8.7, §9.4).
 *
 * Exported because three other modules depend on it and none of them should reach past it
 * to the repository: `audits` for the `selfie_captured` guard, `audit-zones` for the
 * walk-by `has_evidence` guard, and `question-responses` for E-2's reclassification.
 *
 * `MediaWorker` is a provider here and a handler nowhere: only `worker-general` registers
 * it against the queue (§12.8 keeps image decoding out of the API process), and the API
 * merely carries the class so the two entrypoints share one image.
 */
@Module({
  imports: [CorrectiveActionsModule],
  controllers: [EvidenceController, AuditZoneEvidenceController, AuditEvidenceController],
  providers: [EvidenceService, EvidenceRepository, MediaWorker],
  exports: [EvidenceService, EvidenceRepository, MediaWorker],
})
export class EvidenceModule {}
