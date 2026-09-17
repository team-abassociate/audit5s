import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  generateReportRequestSchema,
  listReportsQuerySchema,
  revokeTokenRequestSchema,
  type GenerateReportRequest,
  type ListReportsQuery,
  type Page,
  type ReportAccessToken,
  type ReportDownloadUrl,
  type ReportPayload,
  type ReportSnapshot,
  type RevokeTokenRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { ReportRenderer } from './report-renderer';
import { ReportTokensService } from './report-tokens.service';
import { ReportsService } from './reports.service';

/**
 * Reports (§8.9).
 *
 * **Consultants have no route here** (N5/C4). A Consultant posting to `/reports/generate`
 * is refused `403` by `PermissionGuard` — because `report:generate` has no grant for the
 * role at all, not because a scope excluded them. Their read model is
 * `GET /audits/{id}/summary` (§8.6), which is not a report and says so.
 *
 * `:snapshotId` is the name for this parameter position everywhere under `/reports`.
 * Fastify identifies a route node by *position*, not by name, so a second name here would
 * make the router report `:id|:snapshotId` and the authorization completeness check would
 * see a route it has no entry for.
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly tokens: ReportTokensService,
    private readonly renderer: ReportRenderer,
  ) {}

  /**
   * `202`, never `200` with a PDF. The render happens in `worker-report`; an HTTP request
   * that started a headless Chromium would put a 1.5 GB process behind a button on an
   * 8 GB box (STACK.md §5).
   */
  @RequirePermission('report', 'generate')
  @Scope({ intent: 'write' })
  @Post('generate')
  @HttpCode(HttpStatus.ACCEPTED)
  generate(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(generateReportRequestSchema)) body: GenerateReportRequest,
  ): Promise<ReportSnapshot> {
    return this.reports.generate(scope, body);
  }

  @RequirePermission('report', 'read_snapshot')
  @Scope({ intent: 'read' })
  @Get()
  list(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listReportsQuerySchema)) query: ListReportsQuery,
  ): Promise<Page<ReportSnapshot>> {
    return this.reports.list(scope, query);
  }

  /**
   * Renders HTML from a payload with no snapshot and no PDF (§8.9's `/reports/preview`).
   *
   * Declared before `:snapshotId` so Fastify matches the literal segment rather than
   * treating "preview" as an id — and it takes a **generate request**, not raw HTML, so
   * there is no path by which a caller supplies markup this application then renders.
   */
  @RequirePermission('report', 'generate')
  @Scope({ intent: 'write' })
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/html; charset=utf-8')
  async preview(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(generateReportRequestSchema)) body: GenerateReportRequest,
  ): Promise<string> {
    return this.renderer.renderHtml(await this.reports.preview(scope, body));
  }

  @RequirePermission('report', 'read_snapshot')
  @Scope({ param: 'snapshotId', intent: 'read' })
  @Get(':snapshotId')
  get(
    @CurrentScope() scope: ScopeContext,
    @Param('snapshotId', ParseUUIDPipe) snapshotId: string,
  ): Promise<ReportSnapshot> {
    return this.reports.get(scope, snapshotId);
  }

  /** The frozen payload, for the on-screen preview of a report already generated. */
  @RequirePermission('report', 'read_snapshot')
  @Scope({ param: 'snapshotId', intent: 'read' })
  @Get(':snapshotId/payload')
  payload(
    @CurrentScope() scope: ScopeContext,
    @Param('snapshotId', ParseUUIDPipe) snapshotId: string,
  ): Promise<ReportPayload> {
    return this.reports.payload(scope, snapshotId);
  }

  /** §12.6: a short-TTL presigned GET, minted **after** the scope check. */
  @RequirePermission('report', 'download')
  @Scope({ param: 'snapshotId', intent: 'read' })
  @Get(':snapshotId/download-url')
  downloadUrl(
    @CurrentScope() scope: ScopeContext,
    @Param('snapshotId', ParseUUIDPipe) snapshotId: string,
  ): Promise<ReportDownloadUrl> {
    return this.reports.downloadUrl(scope, snapshotId);
  }

  /** RS-1: creates version + 1. The original is untouched and stays downloadable. */
  @RequirePermission('report', 'generate')
  @Scope({ param: 'snapshotId', intent: 'write' })
  @Post(':snapshotId/regenerate')
  @HttpCode(HttpStatus.ACCEPTED)
  regenerate(
    @CurrentScope() scope: ScopeContext,
    @Param('snapshotId', ParseUUIDPipe) snapshotId: string,
  ): Promise<ReportSnapshot> {
    return this.reports.regenerate(scope, snapshotId);
  }

  @RequirePermission('report_access_token', 'mint')
  @Scope({ param: 'snapshotId', intent: 'read' })
  @Get(':snapshotId/tokens')
  listTokens(
    @CurrentScope() scope: ScopeContext,
    @Param('snapshotId', ParseUUIDPipe) snapshotId: string,
  ): Promise<ReportAccessToken[]> {
    return this.tokens.listForSnapshot(scope, snapshotId);
  }

  @RequirePermission('report_access_token', 'revoke')
  @Scope({ param: 'snapshotId', intent: 'write' })
  @Post(':snapshotId/tokens/:tokenId/revoke')
  @HttpCode(HttpStatus.OK)
  revokeToken(
    @CurrentScope() scope: ScopeContext,
    @Param('snapshotId', ParseUUIDPipe) snapshotId: string,
    @Param('tokenId', ParseUUIDPipe) tokenId: string,
    @Body(new ZodValidationPipe(revokeTokenRequestSchema)) body: RevokeTokenRequest,
  ): Promise<ReportAccessToken> {
    return this.tokens.revoke(scope, snapshotId, tokenId, body);
  }
}
