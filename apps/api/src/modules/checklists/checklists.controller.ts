import { createHash } from 'node:crypto';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  listChecklistTemplatesQuerySchema,
  listChecklistVersionsQuerySchema,
  updateChecklistTemplateRequestSchema,
  updateQuestionTranslationRequestSchema,
  type ChecklistTemplate,
  type ChecklistVersion,
  type ChecklistVersionDetail,
  type Page,
  type QuestionTranslation,
  type UpdateChecklistTemplateRequest,
  type UpdateQuestionTranslationRequest,
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
   * A published version's questions are immutable at the database (CV-1), but the body
   * also carries their Hindi and Marathi, which a Super Admin may correct (0036). So the
   * ETag covers both, and the browser revalidates rather than trusting a year-long
   * `immutable` that would keep showing a translation after it was fixed.
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
      const wording = createHash('sha256')
        .update(JSON.stringify(detail.questions.map((question) => question.translations ?? {})))
        .digest('hex')
        .slice(0, 16);
      void reply.header('etag', `"${detail.contentHash}-${wording}"`);
      void reply.header('cache-control', 'private, no-cache');
    }
    return detail;
  }

  /**
   * Correct one question's Hindi or Marathi (0036). Keyed by the English sentence, so the
   * fix reaches every version and department asking the same question. Super Admin only,
   * like every other write to the catalogue.
   */
  @RequirePermission('checklist_template', 'update')
  @Scope({ intent: 'write' })
  @Put('checklist-translations')
  updateTranslation(
    @CurrentScope() scope: ScopeContext,
    @Body(new ZodValidationPipe(updateQuestionTranslationRequestSchema))
    body: UpdateQuestionTranslationRequest,
  ): Promise<QuestionTranslation> {
    return this.checklists.updateTranslation(scope, body);
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
