import { Module } from '@nestjs/common';
import { AuditsModule } from '../audits/audits.module';
import { IntegrityRepository } from './integrity.repository';
import { IntegrityWorker } from './integrity.worker';

/**
 * §16.4's nightly data-integrity checks.
 *
 * No controller: the findings reach a Super Admin through the notification fan-out rather
 * than through a route of their own (R-17), so this module has nothing to guard and adds
 * nothing to PART 6.
 *
 * `AuditsModule` is imported for `ScoringService` — the reconciliation recomputes through
 * the same path the write used, which is the only way the comparison means anything.
 */
@Module({
  imports: [AuditsModule],
  providers: [IntegrityRepository, IntegrityWorker],
  exports: [IntegrityWorker],
})
export class MaintenanceModule {}
