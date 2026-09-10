import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  listChecklistTemplatesQuerySchema,
  listChecklistVersionsQuerySchema,
  updateChecklistTemplateRequestSchema,
  type ChecklistTemplate,
  type ChecklistVersion,
  type ChecklistVersionDetail,
  type Page,
  type UpdateChecklistTemplateRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { RequirePermission, Scope } from '../../common/auth/decorators';
import { CurrentScope } from '../../common/auth/current-scope.decorator';
import { ZodValidationPipe } from '../auth/zod.pipe';
import { ChecklistsService } from './checklists.service';

/**
 * Checklist templates and versions (§8.5).
 *
 * Reads are open to every authenticated role because checklists are organization-wide
 * reference data with no Unit in them (D2); writes are Super Admin only.
 */
@Controller()
export class ChecklistsController {
  constructor(private readonly checklists: ChecklistsService) {}

  @RequirePermission('checklist_template', 'read')
  @Scope({ intent: 'read' })
  @Get('checklist-templates')
  listTemplates(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listChecklistTemplatesQuerySchema))
    query: ReturnType<typeof listChecklistTemplatesQuerySchema.parse>,
  ): Promise<Page<ChecklistTemplate>> {
    return this.checklists.listTemplates(scope, query);
  }

  @RequirePermission('checklist_template', 'read')
  @Scope({ param: 'id', intent: 'read' })
  @Get('checklist-templates/:id')
  getTemplate(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChecklistTemplate> {
    return this.checklists.getTemplate(scope, id);
  }

  @RequirePermission('checklist_template', 'update')
  @Scope({ param: 'id', intent: 'write' })
  @Patch('checklist-templates/:id')
  updateTemplate(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateChecklistTemplateRequestSchema))
    body: UpdateChecklistTemplateRequest,
  ): Promise<ChecklistTemplate> {
    return this.checklists.updateTemplate(scope, id, body);
  }

  /** `?status=PUBLISHED` is the mobile catalogue-sync source. */
  @RequirePermission('checklist_version', 'read')
  @Scope({ intent: 'read' })
  @Get('checklist-versions')
  listVersions(
    @CurrentScope() scope: ScopeContext,
    @Query(new ZodValidationPipe(listChecklistVersionsQuerySchema))
    query: ReturnType<typeof listChecklistVersionsQuerySchema.parse>,
  ): Promise<Page<ChecklistVersion>> {
    return this.checklists.listVersions(scope, query);
  }

  /**
   * A published version is immutable at the database (CV-1), which is what makes
   * `Cache-Control: immutable` an honest header rather than a hopeful one.
   */
  @RequirePermission('checklist_version', 'read')
  @Scope({ param: 'id', intent: 'read' })
  @Get('checklist-versions/:id')
  async getVersion(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ChecklistVersionDetail> {
    const detail = await this.checklists.getVersionDetail(scope, id);
    if (detail.status === 'PUBLISHED' || detail.status === 'SUPERSEDED') {
      void reply.header('etag', `"${detail.contentHash}"`);
      void reply.header('cache-control', 'private, max-age=31536000, immutable');
    }
    return detail;
  }

  @RequirePermission('checklist_version', 'publish')
  @Scope({ param: 'id', intent: 'write' })
  @Post('checklist-versions/:id/publish')
  publish(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChecklistVersion> {
    return this.checklists.publish(scope, id);
  }

  @RequirePermission('checklist_version', 'deactivate')
  @Scope({ param: 'id', intent: 'write' })
  @Post('checklist-versions/:id/deactivate')
  deactivate(
    @CurrentScope() scope: ScopeContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ChecklistVersion> {
    return this.checklists.deactivate(scope, id);
  }
}
