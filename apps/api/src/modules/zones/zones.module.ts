import { Module } from '@nestjs/common';
import { CorrectiveActionsModule } from '../corrective-actions/corrective-actions.module';
import { UnitsModule } from '../units/units.module';
import { ZonesController } from './zones.controller';
import { ZonesRepository } from './zones.repository';
import { ZonesService } from './zones.service';

@Module({
  imports: [UnitsModule, CorrectiveActionsModule],
  controllers: [ZonesController],
  providers: [ZonesService, ZonesRepository],
  exports: [ZonesService, ZonesRepository],
})
export class ZonesModule {}
