import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  listSyncConflictsQuerySchema,
  resolveSyncConflictRequestSchema,
  type ListSyncConflictsQuery,
  type Page,
  type ResolveSyncConflictRequest,
  type SyncConflict,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { SyncConflictsService } from './sync-conflicts.service';

/**
 * The quarantine queue (§8.10), Super Admin only.
 *
 * `:conflictId` names this parameter position — one name per position, as Phase 3 settled.
 */
@Controller('sync-conflicts')
export class SyncConflictsController {
  constructor(private readonly conflicts: SyncConflictsService) {}

  @RequirePermission('sync_conflict', 'read')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listSyncConflictsQuerySchema)) query: ListSyncConflictsQuery,
  ): Promise<Page<SyncConflict>> {
    return this.conflicts.list(scope, query);
  }

  @RequirePermission('sync_conflict', 'read')
  @Scope({ param: 'conflictId', intent: 'read' })
  @Get(':conflictId')
  get(
    @CurrentScope() scope: ScopeContext,
    @Param('conflictId', ParseUUIDPipe) conflictId: string,
  ): Promise<SyncConflict> {
    return this.conflicts.get(scope, conflictId);
  }

  /**
   * `APPLY` routes through the post-completion override, so it is audit-logged with before
   * and after exactly as any other override (§8.10). `DISCARD` marks the row resolved and
   * keeps the payload — nothing here can delete field data.
   */
  @RequirePermission('sync_conflict', 'resolve')
  @Scope({ param: 'conflictId', intent: 'write' })
  @Post(':conflictId/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(
    @CurrentScope() scope: ScopeContext,
    @Param('conflictId', ParseUUIDPipe) conflictId: string,
    @Body(new ZodValidationPipe(resolveSyncConflictRequestSchema))
    body: ResolveSyncConflictRequest,
  ): Promise<SyncConflict> {
    return this.conflicts.resolve(scope, conflictId, body);
  }
}
