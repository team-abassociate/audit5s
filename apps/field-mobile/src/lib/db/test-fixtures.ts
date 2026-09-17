import type { SyncCatalogue } from '@audit5s/contracts';
import { S_SECTION_ORDER, TOTAL_QUESTIONS } from '@audit5s/domain';

/**
 * The catalogue fixture the device-store suites share.
 *
 * One copy, because it is the shape `GET /sync/catalogue` returns and that shape is a
 * contract: two copies drift the moment a field is added, and the drift shows up as a
 * type error in whichever test was not updated rather than as the thing it actually is.
 */
export const FIXTURE_UNIT = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_ZONE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
export const FIXTURE_ZONE_B = 'aaaaaaaa-0000-4000-8000-000000000002';
export const FIXTURE_VERSION = 'cccccccc-0000-4000-8000-000000000001';

/** Fifty questions across the five sections, as the catalogue delivers them. */
export function catalogue(): SyncCatalogue {
  const questions: SyncCatalogue['checklistVersions'][number]['questions'] = [];
  for (const [sectionIndex, section] of S_SECTION_ORDER.entries()) {
    for (let order = 1; order <= 10; order += 1) {
      const globalOrder = sectionIndex * 10 + order;
      questions.push({
        id: `q-${String(globalOrder).padStart(2, '0')}`,
        versionId: FIXTURE_VERSION,
        section,
        orderInSection: order,
        globalOrder,
        text: `Question ${globalOrder}`,
        guidance: null,
        // Question 13 is the one that may be NA, so the NA path is exercised on a
        // question that permits it rather than on one that does not.
        allowsNa: globalOrder === 13 || globalOrder === 28 || globalOrder === 45,
        requiresEvidenceOnNonconformity: false,
      });
    }
  }

  return {
    serverTime: '2026-09-10T10:00:00.000Z',
    correctiveActions: [],
    catalogueVersion: 'v1',
    units: [
      {
        id: FIXTURE_UNIT,
        name: 'Nashik Plant',
        address: null,
        city: null,
        state: null,
        country: null,
        postalCode: null,
        contactName: null,
        contactPhone: null,
        contactEmail: null,
        latitude: null,
        longitude: null,
        geofenceRadiusM: 300,
        timezone: 'Asia/Kolkata',
        // The fixture Unit is unclassified (0018), which is what every Unit is until
        // somebody sets a sector — and is therefore offered every checklist.
        industryId: null,
        industryName: null,
        photoCapPerZone: 30,
        version: 1,
        archivedAt: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    zones: [
      zone(FIXTURE_ZONE_A, 'Z-01', 'Press', 'Press shop, bay 3'),
      zone(FIXTURE_ZONE_B, 'Z-02', 'Assembly', null),
    ],
    checklistTemplates: [],
    assignments: [],
    checklistVersions: [
      {
        id: FIXTURE_VERSION,
        templateId: 'dddddddd-0000-4000-8000-000000000001',
        templateCode: 'SHOP_FLOOR',
        templateName: 'Shop Floor',
        versionNumber: 1,
        status: 'PUBLISHED',
        questionsPerSection: 10,
        totalQuestions: TOTAL_QUESTIONS,
        contentHash: 'hash-v1',
        publishedAt: '2026-09-02T00:00:00.000Z',
        publishedByUserId: null,
        supersededAt: null,
        supersededByVersionId: null,
        sourceImportJobId: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        questions,
      },
    ],
  };
}

function zone(id: string, code: string, name: string, description: string | null) {
  return {
    id,
    unitId: FIXTURE_UNIT,
    code,
    name,
    description,
    departmentHint: null,
    defaultChecklistTemplateId: null,
    zoneLeaderId: 'eeeeeeee-0000-4000-8000-000000000001',
    zoneLeaderName: 'Leader One',
    sortOrder: 1,
    version: 1,
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}
