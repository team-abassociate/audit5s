import { Module } from '@nestjs/common';
import { UnitsModule } from '../units/units.module';
import { ZonesController } from './zones.controller';
import { ZonesRepository } from './zones.repository';
import { ZonesService } from './zones.service';

@Module({
  imports: [UnitsModule],
  controllers: [ZonesController],
  providers: [ZonesService, ZonesRepository],
  exports: [ZonesService, ZonesRepository],
})
export class ZonesModule {}
