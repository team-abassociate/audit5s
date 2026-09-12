import { Global, Module } from '@nestjs/common';
import { CorrectiveActionsModule } from '../corrective-actions/corrective-actions.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { PublicCorrectiveActionsController } from './public-corrective-actions.controller';
import { PublicCorrectiveActionsService } from './public-corrective-actions.service';
import { ReportRenderer } from './report-renderer';
import { ReportTokensRepository } from './report-tokens.repository';
import { ReportTokensService } from './report-tokens.service';
import { ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';
import { ReportWorker } from './report.worker';

/**
 * Reports (§5.8, §8.9, PART 10).
 *
 * `@Global` for one reason and one only: `SignedTokenGuard` is registered as an `APP_GUARD`
 * in `AppModule`, and a global guard is resolved from the root injector, so
 * `ReportTokensService` has to be visible there. The alternative — importing this module
 * into `AppModule` and exporting the service — is the same reach with more indirection.
 *
 * `ReportWorker` is a provider here and a handler nowhere: only `worker-report` registers
 * it against the queue (STACK.md §5 keeps Chromium out of the API process), and the API
 * merely carries the class so the three entrypoints share one image.
 */
@Global()
@Module({
  imports: [CorrectiveActionsModule, EvidenceModule],
  controllers: [ReportsController, PublicCorrectiveActionsController],
  providers: [
    ReportsService,
    ReportsRepository,
    ReportTokensService,
    ReportTokensRepository,
    PublicCorrectiveActionsService,
    ReportRenderer,
    ReportWorker,
  ],
  exports: [ReportsService, ReportTokensService, ReportRenderer, ReportWorker],
})
export class ReportsModule {}
