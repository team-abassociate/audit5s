import { Module } from '@nestjs/common';
import { ChecklistsModule } from '../checklists/checklists.module';
import { UnitsModule } from '../units/units.module';
import { ZonesModule } from '../zones/zones.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [UnitsModule, ZonesModule, ChecklistsModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
