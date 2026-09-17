import { Injectable } from '@nestjs/common';
import type {
  ChecklistQuestion,
  ChecklistTemplate,
  ChecklistVersion,
  ChecklistVersionDetail,
  ListChecklistTemplatesQuery,
  ListChecklistVersionsQuery,
  Page,
  UpdateChecklistTemplateRequest,
} from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { QUESTIONS_PER_SECTION, S_SECTION_ORDER, TOTAL_QUESTIONS } from '@audit5s/domain';
import { AppError } from '../../common/errors';
import { AuditLogService } from '../../common/audit-log/audit-log.service';
import { DomainEvents } from '../../infrastructure/queue/domain-events';
import {
  ChecklistsRepository,
  type ChecklistQuestionRow,
  type ChecklistTemplateRow,
  type ChecklistVersionRow,
} from './checklists.repository';

@Injectable()
export class ChecklistsService {
  constructor(
    private readonly repository: ChecklistsRepository,
    private readonly auditLog: AuditLogService,
    private readonly events: DomainEvents,
  ) {}

  async listTemplates(
    scope: ScopeContext,
    query: ListChecklistTemplatesQuery,
  ): Promise<Page<ChecklistTemplate>> {
    const rows = await this.repository.listTemplates(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toTemplate), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  async getTemplate(scope: ScopeContext, templateId: string): Promise<ChecklistTemplate> {
    const row = await this.repository.findTemplateById(scope, templateId);
    if (!row) {
      throw AppError.notFound('No such checklist template');
    }
    return toTemplate(row);
  }

  async updateTemplate(
    scope: ScopeContext,
    templateId: string,
    request: UpdateChecklistTemplateRequest,
  ): Promise<ChecklistTemplate> {
    const before = await this.getTemplate(scope, templateId);
    const updated = await this.repository.updateTemplate(scope, templateId, {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.description !== undefined ? { description: request.description ?? null } : {}),
      ...(request.sortOrder !== undefined ? { sortOrder: request.sortOrder } : {}),
      ...(request.isActive !== undefined ? { isActive: request.isActive } : {}),
    });
    if (!updated) {
      throw AppError.notFound('No such checklist template');
    }

    const after = await this.getTemplate(scope, templateId);
    await this.auditLog.record({
      action: 'checklist.template_updated',
      resourceType: 'checklist_template',
      resourceId: templateId,
      before: { name: before.name, isActive: before.isActive, sortOrder: before.sortOrder },
      after: { name: after.name, isActive: after.isActive, sortOrder: after.sortOrder },
    });
    return after;
  }

  async listVersions(
    scope: ScopeContext,
    query: ListChecklistVersionsQuery,
  ): Promise<Page<ChecklistVersion>> {
    const rows = await this.repository.listVersions(scope, query);
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return { data: page.map(toVersion), nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null };
  }

  async getVersion(scope: ScopeContext, versionId: string): Promise<ChecklistVersion> {
    const row = await this.repository.findVersionById(scope, versionId);
    if (!row) {
      throw AppError.notFound('No such checklist version');
    }
    return toVersion(row);
  }

  async getVersionDetail(
    scope: ScopeContext,
    versionId: string,
  ): Promise<ChecklistVersionDetail> {
    const row = await this.repository.findVersionById(scope, versionId);
    if (!row) {
      throw AppError.notFound('No such checklist version');
    }
    const questions = await this.repository.listQuestions(scope, [versionId]);
    return { ...toVersion(row), questions: questions.map(toQuestion) };
  }

  /** Every published version with its questions — the offline catalogue. */
  async publishedVersionsWithQuestions(scope: ScopeContext): Promise<ChecklistVersionDetail[]> {
    const versions = await this.repository.listPublishedVersions(scope);
    const questions = await this.repository.listQuestions(
      scope,
      versions.map((version) => version.id),
    );

    const byVersion = new Map<string, ChecklistQuestion[]>();
    for (const question of questions) {
      const list = byVersion.get(question.versionId) ?? [];
      list.push(toQuestion(question));
      byVersion.set(question.versionId, list);
    }

    return versions.map((version) => ({
      ...toVersion(version),
      questions: byVersion.get(version.id) ?? [],
    }));
  }

  /**
   * `DRAFT → PUBLISHED`, with the 5×10 check (CQ-1) applied one last time.
   *
   * The importer already refuses a malformed sheet, and the database refuses a bad
   * `total_questions`. This check is neither of those made redundant: it is the guard on
   * the one path that could otherwise publish a version nothing validated — a draft
   * created before a rule changed, or by a future endpoint that is not the importer.
   */
  async publish(scope: ScopeContext, versionId: string): Promise<ChecklistVersion> {
    const version = await this.getVersion(scope, versionId);
    if (version.status !== 'DRAFT') {
      throw AppError.conflict(
        'CHECKLIST_VERSION_NOT_DRAFT',
        `Only a draft may be published; this version is ${version.status}`,
      );
    }

    const questions = await this.repository.listQuestions(scope, [versionId]);
    assertFiveByTen(questions, version.questionsPerSection);

    const result = await this.repository.publish(scope, versionId, scope.actor.userId, (tx) =>
      this.events.emit(tx, {
        type: 'CHECKLIST_PUBLISHED',
        actorUserId: scope.actor.userId,
        unitId: null,
        resourceType: 'checklist_version',
        resourceId: versionId,
        data: { templateName: version.templateName, versionNumber: version.versionNumber },
      }),
    );
    if (result.outcome === 'NOT_FOUND') {
      throw AppError.notFound('No such checklist version');
    }
    if (result.outcome === 'NOT_DRAFT') {
      throw AppError.conflict(
        'CHECKLIST_VERSION_NOT_DRAFT',
        `Only a draft may be published; this version is ${result.status}`,
      );
    }

    await this.auditLog.record({
      action: 'checklist.published',
      resourceType: 'checklist_version',
      resourceId: versionId,
      after: {
        templateCode: version.templateCode,
        versionNumber: version.versionNumber,
        supersededVersionId: result.supersededVersionId,
      },
    });

    return this.getVersion(scope, versionId);
  }

  /** `PUBLISHED → ARCHIVED`. In-flight audits keep the version they pinned. */
  async deactivate(scope: ScopeContext, versionId: string): Promise<ChecklistVersion> {
    const version = await this.getVersion(scope, versionId);
    if (version.status !== 'PUBLISHED') {
      throw AppError.conflict(
        'CHECKLIST_VERSION_NOT_DRAFT',
        `Only a published version may be deactivated; this one is ${version.status}`,
      );
    }

    const row = await this.repository.deactivate(scope, versionId);
    if (!row) {
      throw AppError.conflict('CONFLICT', 'This version is no longer published');
    }

    await this.auditLog.record({
      action: 'checklist.deactivated',
      resourceType: 'checklist_version',
      resourceId: versionId,
      after: { templateCode: version.templateCode, versionNumber: version.versionNumber },
    });

    return this.getVersion(scope, versionId);
  }
}

/** Invariant CQ-1: five sections, ten each, contiguous 1…10. */
function assertFiveByTen(questions: ChecklistQuestionRow[], questionsPerSection: number): void {
  const problems: string[] = [];

  if (questions.length !== S_SECTION_ORDER.length * questionsPerSection) {
    problems.push(
      `${questions.length} questions; ${S_SECTION_ORDER.length * questionsPerSection} are required`,
    );
  }

  for (const section of S_SECTION_ORDER) {
    const inSection = questions
      .filter((question) => question.section === section)
      .sort((a, b) => a.orderInSection - b.orderInSection);

    if (inSection.length !== questionsPerSection) {
      problems.push(`${section} has ${inSection.length} questions; ${questionsPerSection} required`);
      continue;
    }
    if (!inSection.every((question, index) => question.orderInSection === index + 1)) {
      problems.push(`${section} order is not contiguous 1…${questionsPerSection}`);
    }
  }

  if (problems.length > 0) {
    throw AppError.validation(
      `This version does not have the required ${S_SECTION_ORDER.length}×${QUESTIONS_PER_SECTION} shape ` +
        `(${TOTAL_QUESTIONS} questions): ${problems.join('; ')}`,
    );
  }
}

function toTemplate(row: ChecklistTemplateRow): ChecklistTemplate {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    industryId: row.industryId,
    industryName: row.industryName,
    sortOrder: row.sortOrder,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedVersionId: row.publishedVersionId,
    publishedVersionNumber: row.publishedVersionNumber,
  };
}

function toVersion(row: ChecklistVersionRow): ChecklistVersion {
  return {
    id: row.id,
    templateId: row.templateId,
    templateCode: row.templateCode,
    templateName: row.templateName,
    versionNumber: row.versionNumber,
    status: row.status,
    questionsPerSection: row.questionsPerSection,
    totalQuestions: row.totalQuestions,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedByUserId: row.publishedByUserId,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    supersededByVersionId: row.supersededByVersionId,
    sourceImportJobId: row.sourceImportJobId,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
  };
}

function toQuestion(row: ChecklistQuestionRow): ChecklistQuestion {
  return {
    id: row.id,
    versionId: row.versionId,
    section: row.section,
    orderInSection: row.orderInSection,
    globalOrder: row.globalOrder,
    text: row.text,
    guidance: row.guidance,
    allowsNa: row.allowsNa,
    requiresEvidenceOnNonconformity: row.requiresEvidenceOnNonconformity,
  };
}
