import { Controller, Get, Query } from '@nestjs/common';
import { syncCatalogueQuerySchema, type SyncCatalogue } from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /**
   * The offline bootstrap. `sync:pull` is granted to CONSULTANT and ZONE_LEADER only —
   * the two roles that hold a device — so the web apps read the same data through the
   * ordinary resource endpoints instead.
   */
  @RequirePermission('sync', 'pull')
  @Scope({ intent: 'read' })
  @Get('catalogue')
  catalogue(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(syncCatalogueQuerySchema))
    query: ReturnType<typeof syncCatalogueQuerySchema.parse>,
  ): Promise<SyncCatalogue> {
    return this.sync.catalogue(scope, query);
  }
}
