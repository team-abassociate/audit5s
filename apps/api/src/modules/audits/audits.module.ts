import { Module } from '@nestjs/common';
import { AssignmentsModule } from '../audit-assignments/assignments.module';
import { CorrectiveActionsModule } from '../corrective-actions/corrective-actions.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { UnitsModule } from '../units/units.module';
import { AuditZonesController } from '../audit-zones/audit-zones.controller';
import { AuditZonesService } from '../audit-zones/audit-zones.service';
import { ResponsesController } from '../question-responses/responses.controller';
import { ResponsesService } from '../question-responses/responses.service';
import { AuditsController } from './audits.controller';
import { AuditsRepository } from './audits.repository';
import { AuditsService } from './audits.service';
import { ScoringService } from './scoring.service';
import { SelfieRequirement } from './selfie-requirement';

/**
 * The audit engine.
 *
 * `EvidenceModule` is imported rather than merged because Phase 4 made three of this
 * module's rules depend on evidence: the `selfie_captured` guard, the walk-by
 * `has_evidence` guard, and E-2's reclassification when an answer changes. Each goes
 * through `EvidenceService`, so none of them reaches past it to the table.
 *
 * PART 13 lists `audits/`, `audit-zones/` and `question-responses/` as separate module
 * folders, and they are — but they share one Nest module because they share one write
 * boundary and one repository. Splitting the DI would mean either a second repository over
 * the same tables or a service reaching across module edges, and AZ-1 permits neither.
 */
@Module({
  imports: [UnitsModule, AssignmentsModule, EvidenceModule, CorrectiveActionsModule],
  controllers: [AuditsController, AuditZonesController, ResponsesController],
  providers: [
    AuditsService,
    AuditsRepository,
    AuditZonesService,
    ResponsesService,
    ScoringService,
    SelfieRequirement,
  ],
  // `AuditZonesService` and `ResponsesService` are exported for `/sync/batch`, which AZ-5
  // requires to dispatch through the same services the controllers use rather than
  // reaching for the repository — so a rule added to an endpoint is a rule the sync path
  // gets too, with no second place to remember it.
  exports: [
    AuditsService,
    AuditsRepository,
    ScoringService,
    AuditZonesService,
    ResponsesService,
    SelfieRequirement,
  ],
})
export class AuditsModule {}
