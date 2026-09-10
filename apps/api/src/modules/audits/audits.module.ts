import { Module } from '@nestjs/common';
import { AssignmentsModule } from '../audit-assignments/assignments.module';
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
 * PART 13 lists `audits/`, `audit-zones/` and `question-responses/` as separate module
 * folders, and they are — but they share one Nest module because they share one write
 * boundary and one repository. Splitting the DI would mean either a second repository over
 * the same tables or a service reaching across module edges, and AZ-1 permits neither.
 */
@Module({
  imports: [UnitsModule, AssignmentsModule],
  controllers: [AuditsController, AuditZonesController, ResponsesController],
  providers: [
    AuditsService,
    AuditsRepository,
    AuditZonesService,
    ResponsesService,
    ScoringService,
    SelfieRequirement,
  ],
  exports: [AuditsService, AuditsRepository, ScoringService],
})
export class AuditsModule {}
