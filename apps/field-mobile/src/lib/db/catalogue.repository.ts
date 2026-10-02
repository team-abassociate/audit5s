import { and, asc, eq } from 'drizzle-orm';
import type { SyncCatalogue } from '@audit5s/contracts';
import type { LocalDatabase } from './local-database';
import {
  SYNC_META_KEYS,
  checklistQuestionTranslations,
  checklistQuestions,
  checklistVersions,
  localCorrectiveActions,
  syncMeta,
  templateIndustries,
  unitIndustries,
  units,
  zones,
} from './schema';

/**
 * The device's cached reference data.
 *
 * Reference data is replaced **wholesale**, never merged: the catalogue the server sends
 * is the complete answer for this actor's scope, so a Zone that has been archived or a
 * Unit whose assignment was revoked must disappear rather than linger because no delta
 * mentioned it. A merge would quietly keep showing an auditor a Unit they no longer have.
 */
export async function replaceCatalogue(
  database: LocalDatabase,
  catalogue: SyncCatalogue,
): Promise<void> {
  // An empty payload with an unchanged version means "you are current" (§8.11), not
  // "everything was deleted". Writing it would wipe the device on the cheap path.
  if (
    catalogue.units.length === 0 &&
    catalogue.zones.length === 0 &&
    catalogue.checklistVersions.length === 0
  ) {
    await setSyncMeta(database, SYNC_META_KEYS.lastCatalogueSyncAt, new Date().toISOString());
    return;
  }

  await database.delete(localCorrectiveActions);
  await database.delete(checklistQuestionTranslations);
  await database.delete(checklistQuestions);
  await database.delete(checklistVersions);
  await database.delete(zones);
  await database.delete(units);
  await database.delete(unitIndustries);
  await database.delete(templateIndustries);

  const syncedAt = new Date().toISOString();

  if (catalogue.units.length > 0) {
    await database.insert(units).values(
      catalogue.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        latitude: unit.latitude,
        longitude: unit.longitude,
        geofenceRadiusM: unit.geofenceRadiusM,
        timezone: unit.timezone,
        photoCapPerZone: unit.photoCapPerZone,
        syncedAt,
      })),
    );
  }

  if (catalogue.units.length > 0) {
    await database.insert(unitIndustries).values(
      catalogue.units.map((unit) => ({ unitId: unit.id, industryId: unit.industryId })),
    );
  }

  // `industries` is optional here only for a server from before 0042; such a template is
  // treated as offered everywhere, which is what it was then.
  const links = catalogue.checklistTemplates.flatMap((template) =>
    (template.industries ?? []).map((industry) => ({
      templateId: template.id,
      industryId: industry.id,
    })),
  );
  if (links.length > 0) {
    await database.insert(templateIndustries).values(links);
  }

  if (catalogue.zones.length > 0) {
    await database.insert(zones).values(
      catalogue.zones.map((zone) => ({
        id: zone.id,
        unitId: zone.unitId,
        code: zone.code,
        name: zone.name,
        description: zone.description,
        zoneLeaderId: zone.zoneLeaderId,
        zoneLeaderName: zone.zoneLeaderName,
        defaultChecklistTemplateId: zone.defaultChecklistTemplateId,
        sortOrder: zone.sortOrder,
        archived: zone.archivedAt ? 1 : 0,
      })),
    );
  }

  for (const version of catalogue.checklistVersions) {
    await database.insert(checklistVersions).values({
      id: version.id,
      templateId: version.templateId,
      templateName: version.templateName,
      versionNumber: version.versionNumber,
      totalQuestions: version.totalQuestions,
      status: version.status,
    });

    if (version.questions.length > 0) {
      await database.insert(checklistQuestions).values(
        version.questions.map((question) => ({
          id: question.id,
          versionId: version.id,
          section: question.section,
          orderInSection: question.orderInSection,
          globalOrder: question.globalOrder,
          text: question.text,
          guidance: question.guidance,
          allowsNa: question.allowsNa ? 1 : 0,
        })),
      );

      const translated = version.questions.filter(
        (question) => question.translations?.hi || question.translations?.mr,
      );
      if (translated.length > 0) {
        await database.insert(checklistQuestionTranslations).values(
          translated.map((question) => ({
            questionId: question.id,
            textHi: question.translations?.hi ?? null,
            textMr: question.translations?.mr ?? null,
          })),
        );
      }
    }
  }

  if (catalogue.correctiveActions.length > 0) {
    await database.insert(localCorrectiveActions).values(
      catalogue.correctiveActions.map((action) => ({
        id: action.id,
        unitId: action.unitId,
        auditId: action.auditId,
        zoneId: action.zoneId,
        zoneCode: action.zoneCode,
        zoneName: action.zoneName,
        status: action.status,
        section: action.section,
        questionGlobalOrder: action.questionGlobalOrder,
        questionText: action.questionText,
        findingRemark: action.findingRemark,
        beforeEvidenceId: action.evidenceId,
        suggestion: action.suggestion,
        suggestionNo: action.suggestionNo,
        assignedZoneLeaderUserId: action.assignedZoneLeaderUserId,
        dueAt: action.dueAt,
        reopenCount: action.reopenCount,
      })),
    );
  }

  await setSyncMeta(database, SYNC_META_KEYS.catalogueVersion, catalogue.catalogueVersion);
  await setSyncMeta(database, SYNC_META_KEYS.lastCatalogueSyncAt, syncedAt);
  await setSyncMeta(
    database,
    SYNC_META_KEYS.serverTimeOffsetMs,
    String(Date.parse(catalogue.serverTime) - Date.now()),
  );
}

export async function getSyncMeta(
  database: LocalDatabase,
  key: string,
): Promise<string | null> {
  const [row] = await database
    .select({ value: syncMeta.value })
    .from(syncMeta)
    .where(eq(syncMeta.key, key))
    .limit(1);
  return row?.value ?? null;
}

export async function setSyncMeta(
  database: LocalDatabase,
  key: string,
  value: string,
): Promise<void> {
  await database
    .insert(syncMeta)
    .values({ key, value })
    .onConflictDoUpdate({ target: syncMeta.key, set: { value } });
}

/** Every cached Unit. Renders with the radio off (§2.3 step 3). */
export function listLocalUnits(database: LocalDatabase) {
  return database.select().from(units).orderBy(asc(units.name));
}

export function getLocalUnit(database: LocalDatabase, unitId: string) {
  return database.select().from(units).where(eq(units.id, unitId)).limit(1);
}

/** Active Zones of one Unit, in the order the dropdown shows them. */
export function listLocalZones(database: LocalDatabase, unitId: string) {
  return database
    .select()
    .from(zones)
    .where(and(eq(zones.unitId, unitId), eq(zones.archived, 0)))
    .orderBy(asc(zones.sortOrder), asc(zones.code));
}

/**
 * The checklists on this device, narrowed to a Unit's industry when one is given (0042):
 * a template ticked for no industry is offered everywhere, and a Unit with no industry is
 * offered everything.
 */
export async function listLocalChecklistVersions(
  database: LocalDatabase,
  unitId?: string,
) {
  const versions = await database
    .select()
    .from(checklistVersions)
    .orderBy(asc(checklistVersions.templateName));
  if (!unitId) return versions;

  const [unit] = await database
    .select()
    .from(unitIndustries)
    .where(eq(unitIndustries.unitId, unitId))
    .limit(1);
  if (!unit?.industryId) return versions;

  const links = await database.select().from(templateIndustries);
  const ticked = new Map<string, Set<string>>();
  for (const link of links) {
    const set = ticked.get(link.templateId) ?? new Set<string>();
    set.add(link.industryId);
    ticked.set(link.templateId, set);
  }

  return versions.filter((version) => {
    const industries = ticked.get(version.templateId);
    return !industries || industries.has(unit.industryId!);
  });
}

export function getLocalChecklistVersion(database: LocalDatabase, versionId: string) {
  return database
    .select()
    .from(checklistVersions)
    .where(eq(checklistVersions.id, versionId))
    .limit(1);
}

export function listLocalQuestions(database: LocalDatabase, versionId: string) {
  return database
    .select()
    .from(checklistQuestions)
    .where(eq(checklistQuestions.versionId, versionId))
    .orderBy(asc(checklistQuestions.globalOrder));
}
