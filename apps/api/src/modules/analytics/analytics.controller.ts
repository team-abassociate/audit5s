import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  analyticsActivityQuerySchema,
  analyticsRangeQuerySchema,
  analyticsRankingQuerySchema,
  analyticsTrendQuerySchema,
  type AnalyticsActivityQuery,
  type AnalyticsRangeQuery,
  type AnalyticsRankingQuery,
  type AnalyticsTrendQuery,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @RequirePermission('analytics', 'organization_dashboard')
  @Scope({ intent: 'read' })
  @Get('organization/overview')
  organizationOverview(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(analyticsRangeQuerySchema)) query: AnalyticsRangeQuery,
  ) {
    return this.analytics.organizationOverview(scope, query);
  }

  @RequirePermission('analytics', 'unit_dashboard')
  @Scope({ param: 'unitId', intent: 'read' })
  @Get('units/:unitId/overview')
  unitOverview(
    @CurrentScope() scope: ScopeContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Query(new ZodValidationPipe(analyticsRangeQuerySchema)) query: AnalyticsRangeQuery,
  ) {
    return this.analytics.unitOverview(scope, unitId, query);
  }

  @RequirePermission('analytics', 'unit_dashboard')
  @Scope({ param: 'unitId', intent: 'read' })
  @Get('units/:unitId/trend')
  trend(
    @CurrentScope() scope: ScopeContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Query(new ZodValidationPipe(analyticsTrendQuerySchema)) query: AnalyticsTrendQuery,
  ) {
    return this.analytics.trend(scope, unitId, query);
  }

  @RequirePermission('analytics', 'unit_dashboard')
  @Scope({ param: 'unitId', intent: 'read' })
  @Get('units/:unitId/sections')
  sections(
    @CurrentScope() scope: ScopeContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Query(new ZodValidationPipe(analyticsRangeQuerySchema)) query: AnalyticsRangeQuery,
  ) {
    return this.analytics.sections(scope, unitId, query);
  }

  @RequirePermission('analytics', 'unit_dashboard')
  @Scope({ param: 'unitId', intent: 'read' })
  @Get('units/:unitId/zones/ranking')
  ranking(
    @CurrentScope() scope: ScopeContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Query(new ZodValidationPipe(analyticsRankingQuerySchema)) query: AnalyticsRankingQuery,
  ) {
    return this.analytics.ranking(scope, unitId, query);
  }

  @RequirePermission('analytics', 'unit_dashboard')
  @Scope({ param: 'unitId', intent: 'read' })
  @Get('units/:unitId/nonconformities/recurrent')
  recurrent(
    @CurrentScope() scope: ScopeContext,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Query(new ZodValidationPipe(analyticsRangeQuerySchema)) query: AnalyticsRangeQuery,
  ) {
    return this.analytics.recurrent(scope, unitId, query);
  }

  @RequirePermission('analytics', 'unit_dashboard')
  @Scope({ intent: 'read' })
  @Get('corrective-actions/closure')
  closure(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(analyticsActivityQuerySchema)) query: AnalyticsActivityQuery,
  ) {
    return this.analytics.closure(scope, query);
  }

  @RequirePermission('analytics', 'unit_dashboard')
  @Scope({ intent: 'read' })
  @Get('activity/consultants')
  consultants(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(analyticsActivityQuerySchema)) query: AnalyticsActivityQuery,
  ) {
    return this.analytics.consultants(scope, query);
  }

  @RequirePermission('analytics', 'unit_dashboard')
  @Scope({ intent: 'read' })
  @Get('activity/zone-leaders')
  zoneLeaders(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(analyticsActivityQuerySchema)) query: AnalyticsActivityQuery,
  ) {
    return this.analytics.zoneLeaders(scope, query);
  }

  @RequirePermission('analytics', 'own_activity')
  @Scope({ intent: 'read' })
  @Get('activity/me')
  ownActivity(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(analyticsRangeQuerySchema)) query: AnalyticsRangeQuery,
  ) {
    return this.analytics.ownActivity(scope, query);
  }
}
