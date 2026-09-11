import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import {
  syncBatchRequestSchema,
  syncCatalogueQuerySchema,
  type SyncBatchRequest,
  type SyncBatchResponse,
  type SyncCatalogue,
  type SyncStatus,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { SyncService } from './sync.service';
import { SyncBatchService } from './sync-batch.service';
import { SyncStatusService } from './sync-status.service';

@Controller('sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly batches: SyncBatchService,
    private readonly status: SyncStatusService,
  ) {}

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

  /**
   * The push path (§9.3).
   *
   * `sync:push`, and the guard chain runs unchanged — but the real authorization happens
   * per item, in the services each one dispatches to. AZ-5 is explicit that anything
   * reachable from this endpoint checks permission in the service layer as well, because
   * one HTTP call here multiplexes a hundred operations.
   *
   * It answers 200 whatever happened inside. A malformed row produces a verdict, never a
   * status that would discard the other ninety-nine (§9.3).
   */
  @RequirePermission('sync', 'push')
  @Scope({ intent: 'write' })
  @Post('batch')
  @HttpCode(HttpStatus.OK)
  batch(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(syncBatchRequestSchema)) body: SyncBatchRequest,
  ): Promise<SyncBatchResponse> {
    return this.batches.apply(scope, body);
  }

  /** The server's view of this device (§8.11), so a field problem is diagnosable from it. */
  @RequirePermission('sync', 'pull')
  @Scope({ intent: 'read' })
  @Get('status')
  syncStatus(@CurrentScope() scope: ScopeContext): Promise<SyncStatus> {
    return this.status.forCurrentDevice(scope);
  }
}
