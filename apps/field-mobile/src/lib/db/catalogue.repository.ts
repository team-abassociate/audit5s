import { and, asc, eq } from 'drizzle-orm';
import type { SyncCatalogue } from '@audit5s/contracts';
import type { LocalDatabase } from './local-database';
import {
  SYNC_META_KEYS,
  checklistQuestions,
  checklistVersions,
  syncMeta,
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

  await database.delete(checklistQuestions);
  await database.delete(checklistVersions);
  await database.delete(zones);
  await database.delete(units);

  const syncedAt = new Date().toISOString();

  if (catalogue.units.length > 0) {
    await database.insert(units).values(
      catalogue.units.map((unit) => ({
        id: unit.id,
        code: unit.code,
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
    }
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
  return database.select().from(units).orderBy(asc(units.code));
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

export function listLocalChecklistVersions(database: LocalDatabase) {
  return database
    .select()
    .from(checklistVersions)
    .orderBy(asc(checklistVersions.templateName));
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
