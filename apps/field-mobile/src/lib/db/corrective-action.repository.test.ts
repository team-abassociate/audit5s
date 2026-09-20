import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CorrectiveAction, SyncCatalogue } from '@audit5s/contracts';
import { sortSyncItems } from '@audit5s/domain';
import { listOutbox } from './audit.repository';
import { replaceCatalogue } from './catalogue.repository';
import {
  captureAfterPhoto,
  confirmLocalSubmission,
  getLocalCorrectiveAction,
  listLocalCorrectiveActions,
  settleLocalSubmission,
  submitLocalCorrectiveAction,
} from './corrective-action.repository';
import { queueEvidenceCommit } from './evidence.repository';
import { createLocalDatabase, migrateLocalDatabase, type LocalDatabase } from './local-database';
import { createNodeExecutor } from './node-executor';
import { FIXTURE_UNIT, FIXTURE_ZONE_A, catalogue } from './test-fixtures';

/**
 * The Zone Leader's corrective actions on the device, against real SQLite (§2.4, §9.2).
 */

let executor: ReturnType<typeof createNodeExecutor>;
let database: LocalDatabase;

const ACTION = 'dddddddd-0000-4000-8000-000000000001';
const AUDIT = 'eeeeeeee-0000-4000-8000-000000000001';

function action(overrides: Partial<CorrectiveAction> = {}): CorrectiveAction {
  return {
    id: ACTION,
    evidenceId: 'ffffffff-0000-4000-8000-000000000001',
    auditId: AUDIT,
    auditZoneId: 'ffffffff-0000-4000-8000-000000000002',
    unitId: FIXTURE_UNIT,
    zoneId: FIXTURE_ZONE_A,
    checklistQuestionId: null,
    status: 'OPEN',
    assignedZoneLeaderUserId: null,
    assignedZoneLeaderName: null,
    dueAt: '2026-09-18T00:00:00.000Z',
    openedAt: '2026-09-11T00:00:00.000Z',
    lastSubmittedAt: null,
    resolvedAt: null,
    verifiedByUserId: null,
    reopenCount: 0,
    version: 1,
    auditType: 'WALK_BY',
    auditorUserId: 'aaaaaaaa-0000-4000-8000-000000000001',
    auditorName: 'Cara Consult',
    zoneCode: '1',
    zoneName: 'Press',
    section: null,
    questionGlobalOrder: null,
    questionText: null,
    scoreAtCapture: null,
    findingRemark: 'Pallets against the panel',
    auditCompletedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
}

function withActions(actions: CorrectiveAction[]): SyncCatalogue {
  return { ...catalogue(), correctiveActions: actions };
}

beforeEach(async () => {
  executor = createNodeExecutor();
  await migrateLocalDatabase(executor);
  database = createLocalDatabase(executor);
  await replaceCatalogue(database, withActions([action()]));
});

afterEach(() => {
  executor.close();
});

describe('the cached actions (§8.11)', () => {
  it('arrive with the catalogue and are replaced wholesale by the next', async () => {
    expect((await listLocalCorrectiveActions(database)).map((row) => row.id)).toEqual([ACTION]);
    await replaceCatalogue(database, withActions([]));
    expect(await listLocalCorrectiveActions(database)).toEqual([]);
  });
});

describe('Option B, offline', () => {
  it('saves the attempt, queues one submit item, and shows the action as answered', async () => {
    const id = await submitLocalCorrectiveAction(database, {
      actionId: ACTION,
      option: 'NOT_POSSIBLE',
      explanation: 'The rack belongs to the landlord',
    });

    const [item] = (await listOutbox(database)).filter((row) => row.operation === 'submit');
    expect(item?.entityType).toBe('corrective_action_submission');
    expect(item?.entityId).toBe(id);
    expect(JSON.parse(item!.payload)).toMatchObject({ correctiveActionId: ACTION, option: 'NOT_POSSIBLE', id });

    expect((await getLocalCorrectiveAction(database, ACTION))?.effectiveStatus).toBe('NOT_POSSIBLE');
  });

  it('keeps the action answered when a catalogue refresh lands before the push', async () => {
    await submitLocalCorrectiveAction(database, { actionId: ACTION, option: 'NOT_POSSIBLE', explanation: 'No budget' });
    await replaceCatalogue(database, withActions([action({ status: 'OPEN' })]));
    const local = await getLocalCorrectiveAction(database, ACTION);
    expect(local?.status).toBe('OPEN');
    expect(local?.effectiveStatus).toBe('NOT_POSSIBLE');
  });

  it('refuses a second attempt while one is waiting to sync', async () => {
    await submitLocalCorrectiveAction(database, { actionId: ACTION, option: 'NOT_POSSIBLE', explanation: 'No budget' });
    await expect(
      submitLocalCorrectiveAction(database, { actionId: ACTION, option: 'NOT_POSSIBLE', explanation: 'Again' }),
    ).rejects.toThrow(/not waiting/);
  });

  it('refuses a blank explanation with the server’s own schema', async () => {
    await expect(
      submitLocalCorrectiveAction(database, { actionId: ACTION, option: 'NOT_POSSIBLE', explanation: '  ' }),
    ).rejects.toThrow();
    expect(await listOutbox(database)).toHaveLength(0);
  });
});

describe('Option A, offline', () => {
  it('queues the photo on the media queue and the submit after its commit', async () => {
    const submissionId = 'bbbbbbbb-0000-4000-8000-000000000009';
    const photo = await captureAfterPhoto(database, {
      action: { id: ACTION, auditId: AUDIT },
      submissionId,
      localFileUri: 'file:///after.jpg',
      byteSize: 1000,
      checksumSha256: 'a'.repeat(64),
    });
    await submitLocalCorrectiveAction(database, {
      actionId: ACTION,
      submissionId,
      option: 'COMPLETED',
      submittedByName: 'Zoe Leader',
      description: 'Relabelled',
      afterEvidenceId: photo,
    });

    const media = (await listOutbox(database)).find((row) => row.queue === 'media')!;
    expect(JSON.parse(media.payload)).toMatchObject({
      kind: 'CORRECTIVE_AFTER',
      correctiveActionId: ACTION,
      correctiveActionSubmissionId: submissionId,
      isLiveCapture: true,
    });

    // The media pass uploads, then queues the commit; the data pass must send it first.
    await queueEvidenceCommit(database, photo);
    const data = (await listOutbox(database)).filter((row) => row.queue === 'data');
    const order = sortSyncItems(
      data.map((row) => ({ entityType: row.entityType as never, operation: row.operation as never, createdAt: row.createdAt })),
    ).map((row) => `${row.entityType}:${row.operation}`);
    expect(order).toEqual(['evidence:commit', 'corrective_action_submission:submit']);
  });
});

describe('the server’s verdict', () => {
  it('ACCEPTED removes the local attempt and records the new status', async () => {
    const id = await submitLocalCorrectiveAction(database, { actionId: ACTION, option: 'NOT_POSSIBLE', explanation: 'x' });
    await confirmLocalSubmission(database, id);
    const local = await getLocalCorrectiveAction(database, ACTION);
    expect(local?.pendingSubmissionId).toBeNull();
    expect(local?.status).toBe('NOT_POSSIBLE');
  });

  it('CONFLICT settles it and leaves the status to the next catalogue', async () => {
    const id = await submitLocalCorrectiveAction(database, { actionId: ACTION, option: 'NOT_POSSIBLE', explanation: 'x' });
    await settleLocalSubmission(database, id);
    const local = await getLocalCorrectiveAction(database, ACTION);
    expect(local?.effectiveStatus).toBe('OPEN');
  });
});
