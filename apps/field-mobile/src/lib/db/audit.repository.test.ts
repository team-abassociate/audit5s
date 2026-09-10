import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResponseValue, SyncCatalogue } from '@audit5s/contracts';
import { S_SECTION_ORDER, TOTAL_QUESTIONS, scoreZone } from '@audit5s/domain';
import {
  addLocalZone,
  completeLocalAudit,
  completeLocalZone,
  createLocalAudit,
  getLocalAuditZone,
  listLocalAudits,
  listOutbox,
  listQuestionsWithAnswers,
  pauseLocalAudit,
  pendingOutboxCount,
  resumeCursor,
  resumeLocalAudit,
  saveLocalResponse,
  saveZoneRemark,
  scoreLocalZone,
  uuidv7,
} from './audit.repository';
import { replaceCatalogue } from './catalogue.repository';
import { createLocalDatabase, migrateLocalDatabase, type LocalDatabase } from './local-database';
import { LOCAL_SCHEMA_VERSION } from './migrations';
import { createNodeExecutor } from './node-executor';

/**
 * The device's audit store, against **real SQLite**.
 *
 * The runtime is swapped, not the database: these are the statements Drizzle issues on a
 * phone, executed by an actual SQLite through `node:sqlite`. That matters more here than
 * anywhere else in this codebase — a query that is wrong on a device in a plant with no
 * signal cannot be hotfixed the way a server one can, and the data it damages is the only
 * copy.
 *
 * The last describe block is half of the Phase 3 acceptance row: a Consultant completes a
 * fifty-question Zone entirely offline, and the score computed here is produced by the
 * same `packages/domain` function the server runs on the way in.
 */

let executor: ReturnType<typeof createNodeExecutor>;
let database: LocalDatabase;

const UNIT = '11111111-1111-4111-8111-111111111111';
const ZONE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ZONE_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const VERSION = 'cccccccc-0000-4000-8000-000000000001';

beforeEach(async () => {
  executor = createNodeExecutor();
  await migrateLocalDatabase(executor);
  database = createLocalDatabase(executor);
  await replaceCatalogue(database, catalogue());
});

afterEach(() => {
  executor.close();
});

/** Fifty questions across the five sections, as the catalogue delivers them. */
function catalogue(): SyncCatalogue {
  const questions = [];
  for (const [sectionIndex, section] of S_SECTION_ORDER.entries()) {
    for (let order = 1; order <= 10; order += 1) {
      const globalOrder = sectionIndex * 10 + order;
      questions.push({
        id: `q-${String(globalOrder).padStart(2, '0')}`,
        versionId: VERSION,
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
    catalogueVersion: 'v1',
    units: [
      {
        id: UNIT,
        code: 'U-NASHIK',
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
        photoCapPerZone: 30,
        version: 1,
        archivedAt: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    zones: [
      zone(ZONE_A, 'Z-01', 'Press', 'Press shop, bay 3'),
      zone(ZONE_B, 'Z-02', 'Assembly', null),
    ],
    checklistTemplates: [],
    assignments: [],
    checklistVersions: [
      {
        id: VERSION,
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
        updatedAt: '2026-09-02T00:00:00.000Z',
        questions,
      },
    ],
  } as SyncCatalogue;
}

function zone(id: string, code: string, name: string, description: string | null) {
  return {
    id,
    unitId: UNIT,
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

async function startAudit(): Promise<{ auditId: string; auditZoneId: string }> {
  const auditId = await createLocalAudit(database, {
    unitId: UNIT,
    auditType: 'EXTERNAL_5S',
    checklistVersionId: VERSION,
  });
  const auditZoneId = await addLocalZone(database, {
    auditId,
    zoneId: ZONE_A,
    sequenceNo: 1,
    checklistVersionId: VERSION,
  });
  return { auditId, auditZoneId };
}

/** The fifty-answer pattern, matching the one the API suite pushes. */
function fiftyAnswers(): ResponseValue[] {
  const values: ResponseValue[] = [];
  for (let index = 0; index < TOTAL_QUESTIONS; index += 1) {
    if (index === 12 || index === 27 || index === 44) values.push('NA');
    else if (index % 7 === 0) values.push('SCORE_0');
    else if (index % 3 === 0) values.push('SCORE_1');
    else values.push('SCORE_2');
  }
  return values;
}

async function answerAll(auditId: string, auditZoneId: string, values: readonly ResponseValue[]) {
  const questions = await listQuestionsWithAnswers(database, auditZoneId, VERSION);
  for (const [index, value] of values.entries()) {
    const question = questions[index]!;
    await saveLocalResponse(database, {
      auditZoneId,
      auditId,
      checklistQuestionId: question.questionId,
      section: question.section as (typeof S_SECTION_ORDER)[number],
      globalOrder: question.globalOrder,
      value,
    });
  }
  return questions;
}

describe('the local schema', () => {
  it('is at version 2, with the locally authored tables of §9.1', async () => {
    expect(await executor.userVersion()).toBe(LOCAL_SCHEMA_VERSION);
    expect(LOCAL_SCHEMA_VERSION).toBe(2);

    const tables = await executor.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      [],
    );
    const names = tables.map((row) => row[0]);
    expect(names).toEqual(
      expect.arrayContaining(['audit', 'audit_zone', 'question_response', 'outbox']),
    );
  });

  it('is forward-only and idempotent — re-running migrations changes nothing', async () => {
    const { auditId } = await startAudit();
    await migrateLocalDatabase(executor);

    // A device holds the only copy of its unsynced work; a migration that dropped a table
    // to recreate it would be a data-loss bug that only appears in the field.
    const audits = await listLocalAudits(database);
    expect(audits.map((audit) => audit.id)).toContain(auditId);
  });
});

describe('uuidv7', () => {
  it('produces time-ordered ids with the right version and variant nibbles', () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);

    expect(early).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Time-ordered as strings, which is what keeps index locality on both sides (D12).
    expect(early < late).toBe(true);
  });
});

describe('starting an audit', () => {
  it('writes the audit and queues it, without any network call', async () => {
    const auditId = await createLocalAudit(database, {
      unitId: UNIT,
      auditType: 'EXTERNAL_5S',
      checklistVersionId: VERSION,
    });

    const [audit] = await listLocalAudits(database);
    expect(audit?.id).toBe(auditId);
    expect(audit?.status).toBe('IN_PROGRESS');
    expect(audit?.syncState).toBe('LOCAL_ONLY');

    const queued = await listOutbox(database);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ entityType: 'audit', entityId: auditId, operation: 'upsert' });
  });

  it('takes the D6 snapshots from the cached Zone at the moment it is added', async () => {
    const { auditZoneId } = await startAudit();
    const [zoneRow] = await getLocalAuditZone(database, auditZoneId);

    expect(zoneRow).toMatchObject({
      zoneCodeSnapshot: 'Z-01',
      zoneNameSnapshot: 'Press',
      zoneDescriptionSnapshot: 'Press shop, bay 3',
      zoneLeaderNameSnapshot: 'Leader One',
      status: 'DRAFT',
    });
  });

  it('refuses a Zone that is not in this device’s catalogue', async () => {
    const auditId = await createLocalAudit(database, {
      unitId: UNIT,
      auditType: 'EXTERNAL_5S',
      checklistVersionId: VERSION,
    });

    await expect(
      addLocalZone(database, {
        auditId,
        zoneId: 'ffffffff-0000-4000-8000-000000000099',
        sequenceNo: 1,
        checklistVersionId: VERSION,
      }),
    ).rejects.toThrow(/not in this device/);
  });
});

describe('saving answers', () => {
  it('commits per response and derives numeric_score from the enum', async () => {
    const { auditId, auditZoneId } = await startAudit();
    const questions = await listQuestionsWithAnswers(database, auditZoneId, VERSION);

    await saveLocalResponse(database, {
      auditZoneId,
      auditId,
      checklistQuestionId: questions[0]!.questionId,
      section: 'S1_SORT',
      globalOrder: 1,
      value: 'SCORE_1',
      remark: 'Two unlabelled bins',
    });
    await saveLocalResponse(database, {
      auditZoneId,
      auditId,
      checklistQuestionId: questions[12]!.questionId,
      section: 'S2_SET_IN_ORDER',
      globalOrder: 13,
      value: 'NA',
    });

    const rows = await executor.query(
      `SELECT global_order, value, numeric_score, remark FROM question_response
       ORDER BY global_order`,
      [],
    );
    expect(rows).toEqual([
      [1, 'SCORE_1', 1, 'Two unlabelled bins'],
      [13, 'NA', null, null],
    ]);
  });

  it('updates one row when the auditor changes their mind, and queues one item', async () => {
    const { auditId, auditZoneId } = await startAudit();
    const questions = await listQuestionsWithAnswers(database, auditZoneId, VERSION);

    for (const value of ['SCORE_0', 'SCORE_1', 'SCORE_2', 'SCORE_1'] as const) {
      await saveLocalResponse(database, {
        auditZoneId,
        auditId,
        checklistQuestionId: questions[0]!.questionId,
        section: 'S1_SORT',
        globalOrder: 1,
        value,
      });
    }

    const rows = await executor.query(`SELECT COUNT(*), value FROM question_response`, []);
    expect(rows[0]).toEqual([1, 'SCORE_1']);

    // Coalesced: `UNIQUE(entity_type, entity_id, operation)` means four saves are one
    // queued item, so an auditor who fidgets does not send four requests.
    const queued = await listOutbox(database);
    expect(queued.filter((item) => item.entityType === 'question_response')).toHaveLength(1);
  });

  it('moves the Zone off DRAFT on the first answer and tracks the cursor', async () => {
    const { auditId, auditZoneId } = await startAudit();
    const questions = await listQuestionsWithAnswers(database, auditZoneId, VERSION);

    await saveLocalResponse(database, {
      auditZoneId,
      auditId,
      checklistQuestionId: questions[0]!.questionId,
      section: 'S1_SORT',
      globalOrder: 1,
      value: 'SCORE_2',
    });

    const [zoneRow] = await getLocalAuditZone(database, auditZoneId);
    expect(zoneRow?.status).toBe('IN_PROGRESS');
    expect(zoneRow?.startedAt).not.toBeNull();
    expect(zoneRow?.resumeQuestionId).toBe(questions[0]!.questionId);
  });

  it('joins answers onto the questionnaire in global order', async () => {
    const { auditId, auditZoneId } = await startAudit();
    await answerAll(auditId, auditZoneId, fiftyAnswers().slice(0, 3));

    const rows = await listQuestionsWithAnswers(database, auditZoneId, VERSION);
    expect(rows).toHaveLength(TOTAL_QUESTIONS);
    expect(rows.map((row) => row.globalOrder).slice(0, 3)).toEqual([1, 2, 3]);
    expect(rows.slice(0, 3).map((row) => row.value)).toEqual(['SCORE_0', 'SCORE_2', 'SCORE_2']);
    // Unanswered questions come back with a null value rather than being absent, so the
    // questionnaire can page through all fifty from one query.
    expect(rows[3]?.value).toBeNull();
  });
});

describe('abort and resume (N7, §9.8)', () => {
  it('keeps every answer and reopens at the same question, with no network', async () => {
    const { auditId, auditZoneId } = await startAudit();
    const questions = await answerAll(auditId, auditZoneId, fiftyAnswers().slice(0, 23));

    await pauseLocalAudit(database, auditId, 'Shift ended');

    const audits = await listLocalAudits(database);
    expect(audits[0]?.status).toBe('PAUSED');
    expect(audits[0]?.pauseReason).toBe('Shift ended');

    const saved = await executor.query(`SELECT COUNT(*) FROM question_response`, []);
    expect(saved[0]?.[0]).toBe(23);

    const cursor = await resumeCursor(database, auditId);
    expect(cursor.auditZoneId).toBe(auditZoneId);
    expect(cursor.questionId).toBe(questions[22]!.questionId);
    expect(cursor.answered).toBe(23);

    await resumeLocalAudit(database, auditId);
    const resumed = await listLocalAudits(database);
    expect(resumed[0]?.status).toBe('IN_PROGRESS');
    expect(resumed[0]?.pausedAt).toBeNull();

    // The cursor survives the round trip, which is what "resumes at the same question"
    // means when the device has been in a drawer for three days.
    const after = await resumeCursor(database, auditId);
    expect(after.questionId).toBe(questions[22]!.questionId);
  });

  it('queues the pause without blocking on it', async () => {
    const { auditId, auditZoneId } = await startAudit();
    await answerAll(auditId, auditZoneId, ['SCORE_2']);
    await pauseLocalAudit(database, auditId, null);

    const queued = await listOutbox(database);
    const pause = queued.find((item) => item.operation === 'pause');
    expect(pause).toBeDefined();
    expect(JSON.parse(pause!.payload)).toMatchObject({ resumeAuditZoneId: auditZoneId });
    expect(await pendingOutboxCount(database)).toBe(queued.length);
  });
});

describe('scoring on the device', () => {
  it('is the shared domain function over the stored rows', async () => {
    const { auditId, auditZoneId } = await startAudit();
    const values = fiftyAnswers();
    await answerAll(auditId, auditZoneId, values);

    const onDevice = await scoreLocalZone(database, auditZoneId);
    const expected = scoreZone(
      values.map((value, index) => ({ section: S_SECTION_ORDER[Math.floor(index / 10)]!, value })),
    );

    expect(onDevice).toEqual(expected);
  });

  it('excludes NA from the denominator (D3)', async () => {
    const { auditId, auditZoneId } = await startAudit();
    const questions = await listQuestionsWithAnswers(database, auditZoneId, VERSION);

    // Nine perfect answers and one NA: 18/18, not 18/20.
    for (let index = 0; index < 9; index += 1) {
      await saveLocalResponse(database, {
        auditZoneId,
        auditId,
        checklistQuestionId: questions[index]!.questionId,
        section: 'S1_SORT',
        globalOrder: index + 1,
        value: 'SCORE_2',
      });
    }
    await saveLocalResponse(database, {
      auditZoneId,
      auditId,
      checklistQuestionId: questions[12]!.questionId,
      section: 'S2_SET_IN_ORDER',
      globalOrder: 13,
      value: 'NA',
    });

    const breakdown = await scoreLocalZone(database, auditZoneId);
    expect(breakdown.totals).toMatchObject({
      applicableQuestions: 9,
      naQuestions: 1,
      rawScore: 18,
      maxScore: 18,
      scorePercentage: 100,
    });
    // A section with nothing applicable is null, not zero (D4).
    expect(breakdown.sections.find((s) => s.section === 'S2_SET_IN_ORDER')?.scorePercentage).toBeNull();
  });

  it('scores an untouched Zone as null rather than zero', async () => {
    const { auditZoneId } = await startAudit();
    const breakdown = await scoreLocalZone(database, auditZoneId);
    expect(breakdown.totals.scorePercentage).toBeNull();
  });
});

describe('a complete offline Zone — the Phase 3 acceptance row, device half', () => {
  it('records fifty answers, a remark and a finish with no network at all', async () => {
    const { auditId, auditZoneId } = await startAudit();
    const values = fiftyAnswers();
    await answerAll(auditId, auditZoneId, values);
    await saveZoneRemark(database, auditZoneId, 'Housekeeping improving on the press line');
    await completeLocalZone(database, auditZoneId);
    await completeLocalAudit(database, auditId);

    const [zoneRow] = await getLocalAuditZone(database, auditZoneId);
    expect(zoneRow?.status).toBe('COMPLETED');
    expect(zoneRow?.zoneRemark).toBe('Housekeeping improving on the press line');
    // A finished Zone has nowhere to resume to.
    expect(zoneRow?.resumeQuestionId).toBeNull();

    const answered = await executor.query(
      `SELECT COUNT(*), COUNT(numeric_score) FROM question_response WHERE audit_zone_id = ?`,
      [auditZoneId],
    );
    // Fifty answers, forty-seven of them applicable: `COUNT(numeric_score)` *is* the
    // applicable count on the device too, exactly as QR-1 makes it on the server.
    expect(answered[0]).toEqual([50, 47]);

    const onDevice = await scoreLocalZone(database, auditZoneId);
    expect(onDevice.totals.applicableQuestions).toBe(47);
    expect(onDevice.totals.naQuestions).toBe(3);
    expect(onDevice.totals.scorePercentage).not.toBeNull();

    // Everything the server has to hear about is queued, and nothing waited for it.
    const queued = await listOutbox(database);
    expect(queued.filter((item) => item.entityType === 'question_response')).toHaveLength(50);
    expect(queued.some((item) => item.entityType === 'audit' && item.operation === 'complete')).toBe(
      true,
    );
    expect(queued.every((item) => item.state === 'PENDING')).toBe(true);
  });

  it('keeps two Zones of one audit apart', async () => {
    const { auditId, auditZoneId } = await startAudit();
    const secondZoneId = await addLocalZone(database, {
      auditId,
      zoneId: ZONE_B,
      sequenceNo: 2,
      checklistVersionId: VERSION,
    });

    await answerAll(auditId, auditZoneId, Array.from({ length: 10 }, () => 'SCORE_2' as const));
    await answerAll(auditId, secondZoneId, Array.from({ length: 10 }, () => 'SCORE_0' as const));

    expect((await scoreLocalZone(database, auditZoneId)).totals.scorePercentage).toBe(100);
    expect((await scoreLocalZone(database, secondZoneId)).totals.scorePercentage).toBe(0);
  });
});
