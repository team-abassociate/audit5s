import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResponseValue } from '@audit5s/contracts';
import { S_SECTION_ORDER, TOTAL_QUESTIONS, scoreZone } from '@audit5s/domain';
import {
  addLocalZone,
  applyLocalOverride,
  completeLocalAudit,
  completeLocalZone,
  createLocalAudit,
  editLocalZone,
  getLocalAuditZone,
  listLocalAudits,
  listOutbox,
  listQuestionsWithAnswers,
  listResumableAudits,
  pauseLocalAudit,
  pendingOutboxCount,
  restartLocalAudit,
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
import {
  FIXTURE_UNIT as UNIT,
  FIXTURE_VERSION as VERSION,
  FIXTURE_ZONE_A as ZONE_A,
  catalogue,
} from './test-fixtures';

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

beforeEach(async () => {
  executor = createNodeExecutor();
  await migrateLocalDatabase(executor);
  database = createLocalDatabase(executor);
  await replaceCatalogue(database, catalogue());
});

afterEach(() => {
  executor.close();
});





async function startAudit(): Promise<{ auditId: string; auditZoneId: string }> {
  const auditId = await createLocalAudit(database, {
    unitId: UNIT,
    auditType: 'EXTERNAL_5S',
    checklistVersionId: VERSION,
  });
  const auditZoneId = await addLocalZone(database, {
    auditId,
    zoneNumber: 1,
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
  it('carries the locally authored tables of §9.1', async () => {
    // The applied version tracks the schema rather than a literal: the *number* is pinned
    // by whichever phase last added a migration (Phase 4's evidence step owns it now), and
    // what this file cares about is that Phase 3's tables are there.
    expect(await executor.userVersion()).toBe(LOCAL_SCHEMA_VERSION);
    expect(LOCAL_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);

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
      zoneId: ZONE_A,
      zoneCodeSnapshot: 'Z-01',
      zoneNameSnapshot: 'Press',
      zoneDescriptionSnapshot: 'Press shop, bay 3',
      zoneLeaderNameSnapshot: 'Leader One',
      zoneLeaderUserIdSnapshot: 'eeeeeeee-0000-4000-8000-000000000001',
      checklistTemplateNameSnapshot: 'Shop Floor',
      status: 'DRAFT',
    });
  });

  it('carries the typed description and leader name in the first queued write (R-19)', async () => {
    const auditId = await createLocalAudit(database, {
      unitId: UNIT,
      auditType: 'WALK_BY',
      checklistVersionId: null,
    });
    const auditZoneId = await addLocalZone(database, {
      auditId,
      zoneNumber: 1,
      sequenceNo: 1,
      checklistVersionId: null,
      zoneDescription: 'North bay during the night shift',
      zoneLeaderName: 'Ravi Kumar',
    });

    expect((await getLocalAuditZone(database, auditZoneId))[0]).toMatchObject({
      zoneDescriptionSnapshot: 'North bay during the night shift',
      zoneLeaderNameSnapshot: 'Ravi Kumar',
      // Not the Zone's own leader, so not their account either.
      zoneLeaderUserIdSnapshot: null,
    });
    const queued = (await listOutbox(database)).find(
      (item) => item.entityType === 'audit_zone' && item.entityId === auditZoneId,
    );
    const payload = JSON.parse(queued!.payload);
    expect(payload).toMatchObject({
      zoneNumber: 1,
      zoneDescription: 'North bay during the night shift',
      zoneLeaderName: 'Ravi Kumar',
    });
    expect(payload).not.toHaveProperty('zoneId');

    await saveZoneRemark(database, auditZoneId, 'Observed after cleanup');
    const coalesced = (await listOutbox(database)).find(
      (item) => item.entityType === 'audit_zone' && item.entityId === auditZoneId,
    );
    expect(JSON.parse(coalesced!.payload)).toMatchObject({
      zoneNumber: 1,
      zoneDescription: 'North bay during the night shift',
      zoneLeaderName: 'Ravi Kumar',
      zoneRemark: 'Observed after cleanup',
    });
  });

  it('adds a Zone the catalogue does not have, named by its number (R-19)', async () => {
    const auditId = await createLocalAudit(database, {
      unitId: UNIT,
      auditType: 'EXTERNAL_5S',
      checklistVersionId: null,
    });

    const auditZoneId = await addLocalZone(database, {
      auditId,
      zoneNumber: 42,
      sequenceNo: 1,
      checklistVersionId: VERSION,
      zoneLeaderName: 'Anita Rao',
    });

    expect((await getLocalAuditZone(database, auditZoneId))[0]).toMatchObject({
      zoneCodeSnapshot: 'Z-42',
      zoneNameSnapshot: 'Zone 42',
      zoneDescriptionSnapshot: null,
      zoneLeaderNameSnapshot: 'Anita Rao',
      zoneLeaderUserIdSnapshot: null,
      checklistVersionId: VERSION,
      checklistTemplateNameSnapshot: 'Shop Floor',
    });
    const queued = (await listOutbox(database)).find(
      (item) => item.entityType === 'audit_zone' && item.entityId === auditZoneId,
    );
    expect(JSON.parse(queued!.payload)).toMatchObject({
      zoneNumber: 42,
      checklistVersionId: VERSION,
      zoneLeaderName: 'Anita Rao',
    });
  });

  it('refuses the same Zone number twice in one audit', async () => {
    const { auditId } = await startAudit();

    await expect(
      addLocalZone(database, {
        auditId,
        zoneNumber: 1,
        sequenceNo: 2,
        checklistVersionId: VERSION,
      }),
    ).rejects.toThrow(/already part of this audit/);
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

describe('reviewing a finished Zone', () => {
  it('records the new answer, rescores, and leaves the Zone finished', async () => {
    const { auditId, auditZoneId } = await startAudit();
    const questions = await answerAll(auditId, auditZoneId, fiftyAnswers());
    await completeLocalZone(database, auditZoneId);

    const before = await scoreLocalZone(database, auditZoneId);
    const [finishedZone] = await getLocalAuditZone(database, auditZoneId);
    expect(finishedZone?.status).toBe('COMPLETED');

    // The Review button, and a mark corrected: question 1 was SCORE_0 in the pattern.
    const first = questions[0]!;
    await saveLocalResponse(database, {
      auditZoneId,
      auditId,
      checklistQuestionId: first.questionId,
      section: first.section as (typeof S_SECTION_ORDER)[number],
      globalOrder: first.globalOrder,
      value: 'SCORE_2',
    });

    const after = await scoreLocalZone(database, auditZoneId);
    expect(after.totals.rawScore).toBe(before.totals.rawScore + 2);

    // The Zone stays finished. Reopening it here would put the device out of step with the
    // server — which keeps it COMPLETED and rescores — and would block "Finish audit"
    // until the auditor found a Submit button five pages down.
    const [reviewed] = await getLocalAuditZone(database, auditZoneId);
    expect(reviewed?.status).toBe('COMPLETED');

    // And the revision is queued, so the server rescores what everyone else reads.
    const queued = await listOutbox(database);
    expect(queued.some((item) => item.entityType === 'question_response')).toBe(true);
  });
});

describe('correcting a finished audit (R-30)', () => {
  it('queues one override per audit, merging every correction and the reason', async () => {
    const { auditId, auditZoneId } = await startAudit();
    await answerAll(auditId, auditZoneId, fiftyAnswers());
    await completeLocalZone(database, auditZoneId);
    await completeLocalAudit(database, auditId);

    const rows = await listQuestionsWithAnswers(database, auditZoneId, VERSION);
    const first = rows[0]!;
    const second = rows[1]!;
    expect(first.responseId).toBeTruthy();

    await applyLocalOverride(database, {
      auditId,
      responseId: first.responseId!,
      value: 'SCORE_2',
      justification: 'Marked 0 in error; the rack was in fact labelled.',
    });

    // The local row moves at once, so the screen and the device's own scoring agree.
    const afterFirst = await listQuestionsWithAnswers(database, auditZoneId, VERSION);
    expect(afterFirst[0]!.value).toBe('SCORE_2');

    await applyLocalOverride(database, {
      auditId,
      responseId: second.responseId!,
      value: 'SCORE_0',
      justification: 'Marked 0 in error; the rack was in fact labelled. Also Q2.',
    });

    // One row, not two: the outbox coalesces on (entity, id, operation), so a merge is the
    // only thing standing between the second correction and the loss of the first.
    const queued = await listOutbox(database);
    const overrides = queued.filter((item) => item.operation === 'override');
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.entityType).toBe('audit');
    expect(overrides[0]!.entityId).toBe(auditId);

    const payload = JSON.parse(overrides[0]!.payload) as {
      justification: string;
      changes: { responses: Array<{ responseId: string; value: string }> };
    };
    expect(payload.justification).toContain('Also Q2');
    expect(payload.changes.responses).toHaveLength(2);
    expect(payload.changes.responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ responseId: first.responseId, value: 'SCORE_2' }),
        expect.objectContaining({ responseId: second.responseId, value: 'SCORE_0' }),
      ]),
    );

    // And nothing went out as an ordinary answer, which a completed audit would refuse.
    expect(
      queued.some(
        (item) => item.entityType === 'question_response' && item.operation === 'upsert',
      ),
    ).toBe(true);
    const responseItems = queued.filter((item) => item.entityType === 'question_response');
    expect(responseItems.every((item) => item.operation === 'upsert')).toBe(true);
  });

  it('corrects the same mark twice without queueing it twice', async () => {
    const { auditId, auditZoneId } = await startAudit();
    await answerAll(auditId, auditZoneId, fiftyAnswers());
    await completeLocalZone(database, auditZoneId);
    await completeLocalAudit(database, auditId);

    const rows = await listQuestionsWithAnswers(database, auditZoneId, VERSION);
    const target = rows[0]!.responseId!;

    await applyLocalOverride(database, { auditId, responseId: target, value: 'SCORE_1', justification: 'First thought.' });
    await applyLocalOverride(database, { auditId, responseId: target, value: 'SCORE_2', justification: 'Second thought.' });

    const overrides = (await listOutbox(database)).filter((item) => item.operation === 'override');
    const payload = JSON.parse(overrides[0]!.payload) as {
      changes: { responses: Array<{ responseId: string; value: string }> };
    };
    expect(payload.changes.responses).toHaveLength(1);
    expect(payload.changes.responses[0]!.value).toBe('SCORE_2');
  });
});

describe('the Overview tab’s resumable audits', () => {
  it('lists an audit in progress with its Zone counts, and drops it once finished', async () => {
    const { auditId, auditZoneId } = await startAudit();
    await answerAll(auditId, auditZoneId, fiftyAnswers());

    const before = await listResumableAudits(database);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      id: auditId,
      unitName: 'Nashik Plant',
      status: 'IN_PROGRESS',
      zonesTotal: 1,
      zonesFinished: 0,
      resumeAuditZoneId: auditZoneId,
    });

    await completeLocalZone(database, auditZoneId);
    const midway = await listResumableAudits(database);
    expect(midway[0]).toMatchObject({ zonesTotal: 1, zonesFinished: 1 });

    // A finished audit is History's, not Overview's: the screen answers "what am I in the
    // middle of", and an audit that is over is not an answer to it.
    await completeLocalAudit(database, auditId);
    expect(await listResumableAudits(database)).toEqual([]);
  });

  it('keeps a paused audit, with the reason the abort recorded', async () => {
    const { auditId } = await startAudit();
    await pauseLocalAudit(database, auditId, 'Aborted by auditor');

    const open = await listResumableAudits(database);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ status: 'PAUSED', pauseReason: 'Aborted by auditor' });
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
      zoneNumber: 2,
      sequenceNo: 2,
      checklistVersionId: VERSION,
    });

    await answerAll(auditId, auditZoneId, Array.from({ length: 10 }, () => 'SCORE_2' as const));
    await answerAll(auditId, secondZoneId, Array.from({ length: 10 }, () => 'SCORE_0' as const));

    expect((await scoreLocalZone(database, auditZoneId)).totals.scorePercentage).toBe(100);
    expect((await scoreLocalZone(database, secondZoneId)).totals.scorePercentage).toBe(0);
  });
});


describe('restarting a finished audit (R-33)', () => {
  it('puts it back in progress, counts the restart, and queues one item with the reason', async () => {
    const { auditId, auditZoneId } = await startAudit();
    await answerAll(auditId, auditZoneId, fiftyAnswers());
    await completeLocalZone(database, auditZoneId);
    await completeLocalAudit(database, auditId);

    const beforeRestart = (await listLocalAudits(database)).find((a) => a.id === auditId)!;
    expect(beforeRestart.status).toBe('COMPLETED');

    await restartLocalAudit(database, auditId, 'Finished before the packing bay');

    // Editable again on this device, without waiting for a connection — the whole point.
    const after = (await listLocalAudits(database)).find((a) => a.id === auditId)!;
    expect(after.status).toBe('IN_PROGRESS');
    expect(after.restartCount).toBe(1);

    const queued = (await listOutbox(database)).filter((row) => row.operation === 'restart');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.entityId).toBe(auditId);
    expect(JSON.parse(queued[0]!.payload as string)).toMatchObject({
      justification: 'Finished before the packing bay',
    });
  });

  it('coalesces two taps into one restart', async () => {
    const { auditId, auditZoneId } = await startAudit();
    await answerAll(auditId, auditZoneId, fiftyAnswers());
    await completeLocalZone(database, auditZoneId);
    await completeLocalAudit(database, auditId);

    await restartLocalAudit(database, auditId, 'First tap, no signal');
    await restartLocalAudit(database, auditId, 'Second tap, still no signal');

    // The outbox coalesces on (entity_type, entity_id, operation): two taps are one
    // restart on the server, not two chances spent.
    const queued = (await listOutbox(database)).filter((row) => row.operation === 'restart');
    expect(queued).toHaveLength(1);
  });
});


describe('correcting the Zone details the auditor typed (R-34)', () => {
  it('rewrites the snapshot on this device and queues one upsert carrying it', async () => {
    const { auditId, auditZoneId } = await startAudit();

    await editLocalZone(database, {
      auditZoneId,
      zoneDescription: 'Press shop, bay 7 — corrected on site',
      zoneLeaderName: 'R. Iyer',
    });

    const [zone] = await getLocalAuditZone(database, auditZoneId);
    expect(zone!.zoneDescriptionSnapshot).toBe('Press shop, bay 7 — corrected on site');
    expect(zone!.zoneLeaderNameSnapshot).toBe('R. Iyer');

    const queued = (await listOutbox(database)).filter(
      (row) => row.entityId === auditZoneId && row.operation === 'upsert',
    );
    // One row, not two: the correction coalesces with the upsert that created the Zone.
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0]!.payload as string)).toMatchObject({
      auditId,
      zoneDescription: 'Press shop, bay 7 — corrected on site',
      zoneLeaderName: 'R. Iyer',
    });
  });

  it('leaves a field alone when the correction does not name it', async () => {
    const { auditZoneId } = await startAudit();
    await editLocalZone(database, { auditZoneId, zoneLeaderName: 'Only the leader' });

    const [zone] = await getLocalAuditZone(database, auditZoneId);
    expect(zone!.zoneLeaderNameSnapshot).toBe('Only the leader');
    // Untouched: only what the correction carries is ever re-snapshotted (R-34).
    const queued = (await listOutbox(database)).filter(
      (row) => row.entityId === auditZoneId && row.operation === 'upsert',
    );
    expect(JSON.parse(queued[0]!.payload as string)).not.toHaveProperty('zoneDescription');
  });
});
