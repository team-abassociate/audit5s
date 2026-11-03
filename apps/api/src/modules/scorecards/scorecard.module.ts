import { Module } from '@nestjs/common';
import { AuditsModule } from '../audits/audits.module';
import { ScorecardController } from './scorecard.controller';
import { ScorecardService } from './scorecard.service';
import { ScorecardWorker } from './scorecard.worker';

/** R-80: the audit score card PDF. The renderer comes from the global ReportsModule. */
@Module({
  imports: [AuditsModule],
  controllers: [ScorecardController],
  providers: [ScorecardService, ScorecardWorker],
  exports: [ScorecardWorker],
})
export class ScorecardModule {}
