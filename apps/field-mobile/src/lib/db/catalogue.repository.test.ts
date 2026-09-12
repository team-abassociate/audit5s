import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyncCatalogue } from '@audit5s/contracts';
import {
  getLocalChecklistVersion,
  getSyncMeta,
  listLocalQuestions,
  listLocalUnits,
  listLocalZones,
  replaceCatalogue,
} from './catalogue.repository';
import { createLocalDatabase, migrateLocalDatabase, type LocalDatabase } from './local-database';
import { createNodeExecutor } from './node-executor';
import { LOCAL_SCHEMA_VERSION } from './migrations';
import { SYNC_META_KEYS } from './schema';

/**
 * The device's local store, tested against real SQLite.
 *
 * The runtime is swapped, not the database: these are the statements Drizzle will issue on
 * a phone, executed by an actual SQLite. That matters more here than anywhere else in the
 * codebase, because a query that is wrong on a device in a plant with no signal cannot be
 * hotfixed the way a server one can.
 */

let executor: ReturnType<typeof createNodeExecutor>;
let database: LocalDatabase;

beforeEach(async () => {
  executor = createNodeExecutor();
  await migrateLocalDatabase(executor);
  database = createLocalDatabase(executor);
});

afterEach(() => {
  executor.close();
});

const UNIT_A = '11111111-1111-4111-8111-111111111111';
const UNIT_B = '22222222-2222-4222-8222-222222222222';

function catalogue(overrides: Partial<SyncCatalogue> = {}): SyncCatalogue {
  return {
    serverTime: '2026-09-10T10:00:00.000Z',
    correctiveActions: [],
    catalogueVersion: 'v1',
    units: [
      {
        id: UNIT_A,
        name: 'Nashik Plant',
        address: null,
        city: null,
        state: null,
        country: null,
        postalCode: null,
        contactName: null,
        contactPhone: null,
        contactEmail: null,
        latitude: 19.99,
        longitude: 73.78,
        geofenceRadiusM: 300,
        timezone: 'Asia/Kolkata',
        photoCapPerZone: 30,
        version: 1,
        archivedAt: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    zones: [
      zone('aaaaaaaa-0000-4000-8000-000000000001', UNIT_A, 'Z-02', 'Assembly', 2),
      zone('aaaaaaaa-0000-4000-8000-000000000002', UNIT_A, 'Z-01', 'Press', 1),
      { ...zone('aaaaaaaa-0000-4000-8000-000000000003', UNIT_A, 'Z-09', 'Old store', 9), archivedAt: '2026-09-05T00:00:00.000Z' },
      zone('bbbbbbbb-0000-4000-8000-000000000001', UNIT_B, 'Z-01', 'Other press', 1),
    ],
    checklistTemplates: [],
    // Phase 3 added open assignments to the catalogue envelope. The reference-data
    // replacement ignores them — they are the auditor's task list, not cached master data.
    assignments: [],
    checklistVersions: [
      {
        id: 'cccccccc-0000-4000-8000-000000000001',
        templateId: 'dddddddd-0000-4000-8000-000000000001',
        templateCode: 'PREMISES',
        templateName: 'Premises',
        versionNumber: 1,
        status: 'PUBLISHED',
        questionsPerSection: 10,
        totalQuestions: 50,
        publishedAt: '2026-09-02T00:00:00.000Z',
        publishedByUserId: null,
        supersededAt: null,
        supersededByVersionId: null,
        sourceImportJobId: null,
        contentHash: 'hash-1',
        createdAt: '2026-09-02T00:00:00.000Z',
        questions: [
          question('eeeeeeee-0000-4000-8000-000000000001', 'S1_SORT', 1, 1, 'No scrap in open areas'),
          question('eeeeeeee-0000-4000-8000-000000000002', 'S1_SORT', 2, 2, 'The scrap yard is demarcated'),
          question('eeeeeeee-0000-4000-8000-000000000003', 'S5_SUSTAIN', 10, 50, 'The score trend is improving'),
        ],
      },
    ],
    ...overrides,
  };
}

function zone(id: string, unitId: string, code: string, name: string, sortOrder: number) {
  return {
    id,
    unitId,
    code,
    name,
    description: null,
    departmentHint: null,
    defaultChecklistTemplateId: null,
    zoneLeaderId: null,
    zoneLeaderName: 'Zoe Leader',
    sortOrder,
    version: 1,
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function question(
  id: string,
  section: 'S1_SORT' | 'S5_SUSTAIN',
  orderInSection: number,
  globalOrder: number,
  text: string,
) {
  return {
    id,
    versionId: 'cccccccc-0000-4000-8000-000000000001',
    section,
    orderInSection,
    globalOrder,
    text,
    guidance: null,
    allowsNa: true,
    requiresEvidenceOnNonconformity: false,
  };
}

describe('the local schema', () => {
  it('creates every cached reference-data table and records its version', async () => {
    expect(await executor.userVersion()).toBe(LOCAL_SCHEMA_VERSION);

    const tables = (await executor.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      [],
    )).flat();
    // The reference-data half. The locally authored tables arrived with the audit engine
    // and are asserted in `audit.repository.test.ts`, alongside the code that writes them.
    expect(tables).toEqual(
      expect.arrayContaining([
        'checklist_question',
        'checklist_version',
        'sync_meta',
        'unit',
        'zone',
      ]),
    );
  });

  it('is safe to migrate twice — a reopened app must not re-run a step', async () => {
    await expect(migrateLocalDatabase(executor)).resolves.toBe(LOCAL_SCHEMA_VERSION);
  });
});

describe('catalogue sync', () => {
  it('writes the Units, Zones, versions and questions the server sent', async () => {
    await replaceCatalogue(database, catalogue());

    const units = await listLocalUnits(database);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ name: 'Nashik Plant', timezone: 'Asia/Kolkata' });

    const version = await getLocalChecklistVersion(
      database,
      'cccccccc-0000-4000-8000-000000000001',
    );
    expect(version[0]).toMatchObject({ templateName: 'Premises', totalQuestions: 50 });

    const questions = await listLocalQuestions(
      database,
      'cccccccc-0000-4000-8000-000000000001',
    );
    expect(questions.map((row) => row.globalOrder)).toEqual([1, 2, 50]);
    expect(questions[0]?.text).toBe('No scrap in open areas');
    expect(questions[0]?.allowsNa).toBe(1);
  });

  it('returns a Unit’s active Zones in dropdown order, archived ones excluded', async () => {
    await replaceCatalogue(database, catalogue());

    const zones = await listLocalZones(database, UNIT_A);
    expect(zones.map((row) => row.code)).toEqual(['Z-01', 'Z-02']);
    expect(zones[0]?.zoneLeaderName).toBe('Zoe Leader');
  });

  it('keeps another Unit’s Zones out of this Unit’s list', async () => {
    await replaceCatalogue(database, catalogue());
    const zones = await listLocalZones(database, UNIT_A);
    expect(zones.every((row) => row.unitId === UNIT_A)).toBe(true);
  });

  it('replaces wholesale: a Zone the server no longer sends disappears', async () => {
    await replaceCatalogue(database, catalogue());
    expect(await listLocalZones(database, UNIT_A)).toHaveLength(2);

    // A revoked assignment, an archived Zone: the second payload is the whole truth.
    await replaceCatalogue(
      database,
      catalogue({
        catalogueVersion: 'v2',
        zones: [zone('aaaaaaaa-0000-4000-8000-000000000002', UNIT_A, 'Z-01', 'Press', 1)],
      }),
    );

    const zones = await listLocalZones(database, UNIT_A);
    expect(zones.map((row) => row.code)).toEqual(['Z-01']);
  });

  it('leaves the cache intact when the server says nothing changed', async () => {
    await replaceCatalogue(database, catalogue());

    // §8.11's cheap path: same catalogueVersion, empty collections. Writing that through
    // would wipe the device, which is exactly the bug this guards.
    await replaceCatalogue(database, {
      serverTime: '2026-09-10T10:05:00.000Z',
      catalogueVersion: 'v1',
      units: [],
      zones: [],
      checklistTemplates: [],
      checklistVersions: [],
      assignments: [],
      correctiveActions: [],
    });

    expect(await listLocalUnits(database)).toHaveLength(1);
    expect(await listLocalZones(database, UNIT_A)).toHaveLength(2);
    expect(await getSyncMeta(database, SYNC_META_KEYS.catalogueVersion)).toBe('v1');
  });

  it('records the catalogue version and the server clock offset', async () => {
    await replaceCatalogue(database, catalogue());

    expect(await getSyncMeta(database, SYNC_META_KEYS.catalogueVersion)).toBe('v1');
    expect(await getSyncMeta(database, SYNC_META_KEYS.lastCatalogueSyncAt)).not.toBeNull();
    expect(await getSyncMeta(database, SYNC_META_KEYS.serverTimeOffsetMs)).toMatch(/^-?\d+$/);
  });

  it('overwrites the questions of a republished version rather than doubling them', async () => {
    await replaceCatalogue(database, catalogue());
    await replaceCatalogue(database, catalogue({ catalogueVersion: 'v2' }));

    const questions = await listLocalQuestions(
      database,
      'cccccccc-0000-4000-8000-000000000001',
    );
    expect(questions).toHaveLength(3);
  });
});
