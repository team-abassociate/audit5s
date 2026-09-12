import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsRollupWorker } from './analytics-rollup.worker';
import { AnalyticsService } from './analytics.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsRepository, AnalyticsService, AnalyticsRollupWorker],
  exports: [AnalyticsRollupWorker],
})
export class AnalyticsModule {}
