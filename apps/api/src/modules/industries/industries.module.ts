import { Module } from '@nestjs/common';
import { IndustriesController } from './industries.controller';
import { IndustriesRepository } from './industries.repository';
import { IndustriesService } from './industries.service';

@Module({
  controllers: [IndustriesController],
  providers: [IndustriesService, IndustriesRepository],
  exports: [IndustriesService, IndustriesRepository],
})
export class IndustriesModule {}
