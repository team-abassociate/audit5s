import { Module } from '@nestjs/common';
import { AssignmentsModule } from '../audit-assignments/assignments.module';
import { AuditsModule } from '../audits/audits.module';
import { ChecklistsModule } from '../checklists/checklists.module';
import { CorrectiveActionsModule } from '../corrective-actions/corrective-actions.module';
import { DevicesModule } from '../devices/devices.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { UnitsModule } from '../units/units.module';
import { ZonesModule } from '../zones/zones.module';
import { SyncBatchService } from './sync-batch.service';
import { SyncConflictsController } from './sync-conflicts.controller';
import { SyncConflictsService } from './sync-conflicts.service';
import { SyncController } from './sync.controller';
import { SyncEventsService } from './sync-events.service';
import { SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';
import { SyncStatusService } from './sync-status.service';
import { DeviceReleaseWorker } from './device-release.worker';

/**
 * Synchronization (§8.11, PART 9).
 *
 * `AuditsModule` is imported for the services `/sync/batch` dispatches to — AZ-5 requires
 * the sync path to go through the same services as the HTTP routes rather than reaching
 * for the repositories, so that a rule added to an endpoint is a rule the sync path gets
 * too. That import is the mechanism, not a convenience.
 */
@Module({
  imports: [
    UnitsModule,
    ZonesModule,
    ChecklistsModule,
    AssignmentsModule,
    AuditsModule,
    EvidenceModule,
    CorrectiveActionsModule,
    DevicesModule,
  ],
  controllers: [SyncController, SyncConflictsController],
  providers: [
    SyncService,
    SyncRepository,
    SyncBatchService,
    SyncStatusService,
    SyncConflictsService,
    SyncEventsService,
    DeviceReleaseWorker,
  ],
  exports: [SyncService, SyncRepository, SyncBatchService, DeviceReleaseWorker],
})
export class SyncModule {}
