import { Module } from '@nestjs/common';
import { AuditZoneEvidenceController, EvidenceController } from './evidence.controller';
import { EvidenceRepository } from './evidence.repository';
import { EvidenceService } from './evidence.service';

/**
 * Evidence (§5.6, §8.7, §9.4).
 *
 * Exported because three other modules depend on it and none of them should reach past it
 * to the repository: `audits` for the `selfie_captured` guard, `audit-zones` for the
 * walk-by `has_evidence` guard, and `question-responses` for E-2's reclassification.
 */
@Module({
  controllers: [EvidenceController, AuditZoneEvidenceController],
  providers: [EvidenceService, EvidenceRepository],
  exports: [EvidenceService, EvidenceRepository],
})
export class EvidenceModule {}
