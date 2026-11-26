import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditDetail, Evidence } from '@audit5s/contracts';
import { adoptServerAudit } from './adopt-audit.repository';
import {
  getLocalAuditZone,
  listLocalResponses,
  listOutbox,
  listResumableAudits,
  pendingOutboxCount,
  resumeCursor,
  resumeLocalAudit,
} from './audit.repository';
import { replaceCatalogue } from './catalogue.repository';
import { listLocalEvidenceForZone } from './evidence.repository';
import { createLocalDatabase, migrateLocalDatabase, type LocalDatabase } from './local-database';
import { createNodeExecutor } from './node-executor';
import {
  FIXTURE_UNIT as UNIT,
  FIXTURE_VERSION as VERSION,
  FIXTURE_ZONE_A as ZONE_A,
  catalogue,
} from './test-fixtures';

/**
 * R-92: an audit started on another device, written into this one's SQLite.
 *
 * Against real SQLite, like the rest of the device store: the point is that what the server
 * returned becomes an audit this phone can resume, with nothing queued to push back.
 */

let executor: ReturnType<typeof createNodeExecutor>;
let database: LocalDatabase;

const AUDIT = '01930000-0000-7000-8000-0000000a0001';
const AUDIT_ZONE = '01930000-0000-7000-8000-0000000a0002';
const RESPONSE = '01930000-0000-7000-8000-0000000a0003';
const PHOTO = '01930000-0000-7000-8000-0000000a0004';
const AT = '2026-11-20T09:30:00.000Z';

beforeEach(async () => {
  executor = createNodeExecutor();
  await migrateLocalDatabase(executor);
  database = createLocalDatabase(executor);
  await replaceCatalogue(database, catalogue());
});

afterEach(() => {
  executor.close();
});

/** The fields `adoptServerAudit` reads; the rest of the shape is the API's business. */
function detail(overrides: Partial<AuditDetail> = {}): AuditDetail {
  return {
    id: AUDIT,
    assignmentId: null,
    unitId: UNIT,
    unitName: 'Pune Plant',
    auditType: 'EXTERNAL_5S',
    status: 'PAUSED',
    checklistVersionId: VERSION,
    selfieEvidenceId: null,
    startedAt: AT,
    completedAt: null,
    pausedAt: AT,
    pauseReason: 'Shift ended',
    restartCount: 0,
    resumeAuditZoneId: AUDIT_ZONE,
    startLatitude: null,
    startLongitude: null,
    startAccuracyM: null,
    startLocationProvider: null,
    startLocationIsMocked: null,
    clientCreatedAt: AT,
    clientUpdatedAt: AT,
    zones: [
      {
        id: AUDIT_ZONE,
        auditId: AUDIT,
        zoneId: ZONE_A,
        sequenceNo: 1,
        status: 'IN_PROGRESS',
        zoneCodeSnapshot: 'Z-1',
        zoneNameSnapshot: 'Stores',
        zoneDescriptionSnapshot: null,
        zoneLeaderUserIdSnapshot: null,
        zoneLeaderNameSnapshot: 'Asha',
        auditeeName: 'Ravi',
        previousNcsAnswer: null,
        checklistVersionId: VERSION,
        checklistTemplateNameSnapshot: 'Shop Floor',
        zoneRemark: null,
        overallActionSuggestions: ['Label the racks'],
        resumeQuestionId: 'q-02',
        startedAt: AT,
        completedAt: null,
        clientUpdatedAt: AT,
        responses: [
          {
            id: RESPONSE,
            auditZoneId: AUDIT_ZONE,
            auditId: AUDIT,
            checklistQuestionId: 'q-01',
            section: 'S1_SORT',
            globalOrder: 1,
            value: 'SCORE_1',
            numericScore: 1,
            remark: 'Rack B unlabelled',
            answeredAt: AT,
            clientUpdatedAt: AT,
            syncState: 'SYNCED',
          },
        ],
      },
    ],
    ...overrides,
  } as unknown as AuditDetail;
}

function photo(): Evidence {
  return {
    id: PHOTO,
    kind: 'QUESTION_PHOTO',
    auditId: AUDIT,
    auditZoneId: AUDIT_ZONE,
    questionResponseId: RESPONSE,
    correctiveActionId: null,
    objectKey: `unit/${UNIT}/audit/${AUDIT}/abc.jpg`,
    contentType: 'image/jpeg',
    byteSize: 1234,
    width: 1920,
    height: 1080,
    checksumSha256: 'abc',
    scoreAtCapture: 'SCORE_1',
    classification: 'NONCONFORMITY',
    remark: null,
    isSummaryFlagged: false,
    latitude: null,
    longitude: null,
    accuracyM: null,
    locationProvider: null,
    capturedAt: AT,
    uploadedAt: AT,
    isLiveCapture: true,
    deletedAt: null,
  } as unknown as Evidence;
}

describe('adoptServerAudit (R-92)', () => {
  it('makes the audit resumable here, at the question it stopped on, with nothing to push', async () => {
    await adoptServerAudit(database, detail(), [photo()], new Map([[PHOTO, 'file:///evidence/photo.jpg']]));

    const [open] = await listResumableAudits(database);
    expect(open).toMatchObject({ id: AUDIT, status: 'PAUSED', zonesTotal: 1, zonesFinished: 0 });
    expect(await resumeCursor(database, AUDIT)).toMatchObject({ auditZoneId: AUDIT_ZONE, questionId: 'q-02' });

    expect(await listLocalResponses(database, AUDIT_ZONE)).toEqual([
      expect.objectContaining({ id: RESPONSE, value: 'SCORE_1', remark: 'Rack B unlabelled', syncState: 'SYNCED' }),
    ]);
    const [zone] = await getLocalAuditZone(database, AUDIT_ZONE);
    expect(zone).toMatchObject({ auditeeName: 'Ravi' });

    const [stored] = await listLocalEvidenceForZone(database, AUDIT_ZONE);
    expect(stored).toMatchObject({ id: PHOTO, localFileUri: 'file:///evidence/photo.jpg', syncState: 'SYNCED' });

    // It came from the server: the outbox has nothing to send back.
    expect(await pendingOutboxCount(database)).toBe(0);
  });

  it('resumes like an audit started here', async () => {
    await adoptServerAudit(database, detail(), []);
    await resumeLocalAudit(database, AUDIT);

    const queued = await listOutbox(database);
    expect(queued.map((item) => `${item.entityType}:${item.operation}`)).toEqual(['audit:resume']);
  });

  it('replaces a stale copy with the server’s, and keeps a photo file already on the phone', async () => {
    await adoptServerAudit(database, detail({ status: 'IN_PROGRESS', pausedAt: null }), [photo()], new Map([[PHOTO, 'file:///mine.jpg']]));
    await adoptServerAudit(database, detail(), [photo()]);

    const [open] = await listResumableAudits(database);
    expect(open?.status).toBe('PAUSED');
    const [stored] = await listLocalEvidenceForZone(database, AUDIT_ZONE);
    expect(stored?.localFileUri).toBe('file:///mine.jpg');
  });
});
