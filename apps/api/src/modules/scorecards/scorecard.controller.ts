import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { ScorecardExport } from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ScorecardService } from './scorecard.service';

/** R-80: `/audits/{auditId}/scorecard` — queue the PDF (202), then poll for its download. */
@Controller('audits/:auditId/scorecard')
export class ScorecardController {
  constructor(private readonly scorecards: ScorecardService) {}

  @RequirePermission('report', 'score_summary')
  @Scope({ param: 'auditId', intent: 'read' })
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  request(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
  ): Promise<ScorecardExport> {
    return this.scorecards.request(scope, auditId);
  }

  /** A short-TTL presigned GET once READY (§12.6), minted after the scope check. */
  @RequirePermission('report', 'score_summary')
  @Scope({ param: 'auditId', intent: 'read' })
  @Get(':exportId')
  status(
    @CurrentScope() scope: ScopeContext,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Param('exportId', ParseUUIDPipe) exportId: string,
  ): Promise<ScorecardExport> {
    return this.scorecards.status(scope, auditId, exportId);
  }
}
