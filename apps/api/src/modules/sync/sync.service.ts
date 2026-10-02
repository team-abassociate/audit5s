import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { TRANSLATED_LANGUAGES, type SyncCatalogue, type SyncCatalogueQuery, type Unit } from '@audit5s/contracts';
import type { ScopeContext } from '@audit5s/domain';
import { scopeFor } from '../../common/auth/scope-for';
import { AssignmentsRepository } from '../audit-assignments/assignments.repository';
import { toAssignment } from '../audit-assignments/assignments.service';
import { ChecklistsService } from '../checklists/checklists.service';
import { CorrectiveActionsService } from '../corrective-actions/corrective-actions.service';
import { toUnit } from '../units/units.service';
import { UnitsRepository } from '../units/units.repository';
import { toZone } from '../zones/zones.service';
import { ZonesRepository } from '../zones/zones.repository';

/**
 * `GET /sync/catalogue` (§8.11) — the entire offline bootstrap.
 *
 * The catalogue is assembled through the same scoped repositories the HTTP endpoints use,
 * so a Consultant's catalogue contains exactly the Units their `assigned_units` resolver
 * admits (open assignments plus optional memberships), and a Zone Leader's exactly their
 * `own_unit`. A device cannot widen it, and cancelling an assignment shrinks it on sync.
 *
 * Checklists are the exception, and deliberately so: they are organization-wide reference
 * data with no Unit in them (D2), so every role gets the whole published catalogue.
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly units: UnitsRepository,
    private readonly zones: ZonesRepository,
    private readonly checklists: ChecklistsService,
    private readonly assignments: AssignmentsRepository,
    private readonly correctiveActions: CorrectiveActionsService,
  ) {}

  async catalogue(scope: ScopeContext, query: SyncCatalogueQuery): Promise<SyncCatalogue> {
    // Each collection is read under the resolver PART 6 grants this role for *that*
    // resource, not under the one that let the caller reach this endpoint. Reusing the
    // sync grant for a Unit read would be a quiet widening.
    const unitRows = await this.units.list(scopeFor(scope, 'unit:read'), {
      limit: 200,
      includeArchived: false,
    });
    const zoneRows = await this.zones.listActiveForCatalogue(scopeFor(scope, 'zone:read'));

    const templatePage = await this.checklists.listTemplates(
      scopeFor(scope, 'checklist_template:read'),
      { limit: 200, includeArchived: false },
    );
    const versions = await this.checklists.publishedVersionsWithQuestions(
      scopeFor(scope, 'checklist_version:read'),
    );
    // Only the actor's **own** open assignments: a Zone Leader reads their Unit's through
    // `/audit-assignments`, but a device's catalogue is the auditor's own task list (§2.3).
    const assignmentRows = await this.assignments.listOpenForAuditor(
      scopeFor(scope, 'audit_assignment:read'),
      scope.actor.userId,
    );

    // §8.11's open corrective actions — a Zone Leader's to-do and what awaits review.
    // R-38: overall actions only to a device that said it can store them.
    const actions = (await this.correctiveActions.listForCatalogue(scope)).filter(
      (action) => query.overallActions || action.evidenceId !== null,
    );

    const units: Unit[] = unitRows.map(toUnit);
    const zones = zoneRows.map(toZone);

    const catalogueVersion = fingerprint([
      ...units.map((unit) => `u:${unit.id}:${unit.version}:${unit.updatedAt}`),
      ...zones.map((zone) => `z:${zone.id}:${zone.version}:${zone.updatedAt}`),
      // A published version is immutable (CV-1), so its content hash is a complete
      // description of it: no timestamp is needed to notice a change.
      ...versions.map((version) => `v:${version.id}:${version.contentHash}`),
      // A translation is not part of that hash — it may be corrected after publishing
      // (0036) — so a changed wording has to move the token on its own, or no device
      // would ever fetch it.
      ...versions.map(
        (version) =>
          `vt:${version.id}:${JSON.stringify(
            version.questions.map((question) =>
              TRANSLATED_LANGUAGES.map((language) => question.translations?.[language] ?? null),
            ),
          )}`,
      ),
      // The industries ride along (0042): which checklists a Unit is offered is decided on
      // the device, so a re-tag has to move the token even though no version changed.
      ...templatePage.data.map(
        (template) =>
          `t:${template.id}:${template.updatedAt}:${template.industries.map((industry) => industry.id).join(',')}`,
      ),
      ...assignmentRows.map((assignment) => `a:${assignment.id}:${assignment.status}:${assignment.updatedAt.toISOString()}`),
      ...actions.map((action) => `c:${action.id}:${action.status}:${action.version}`),
    ]);

    // Unchanged: the device keeps everything it has and writes nothing. This is the cheap
    // path on a field connection, which is the normal one.
    if (query.since && query.since === catalogueVersion) {
      return {
        serverTime: new Date().toISOString(),
        catalogueVersion,
        units: [],
        zones: [],
        checklistTemplates: [],
        checklistVersions: [],
        assignments: [],
        correctiveActions: [],
      };
    }

    return {
      serverTime: new Date().toISOString(),
      catalogueVersion,
      units,
      zones,
      checklistTemplates: templatePage.data,
      checklistVersions: versions,
      assignments: assignmentRows.map(toAssignment),
      correctiveActions: actions,
    };
  }
}

/** Stable over content, so an unchanged catalogue yields an unchanged token. */
function fingerprint(parts: string[]): string {
  return createHash('sha256').update([...parts].sort().join('\n'), 'utf8').digest('hex').slice(0, 32);
}
