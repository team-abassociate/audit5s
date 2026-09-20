import { asc, eq } from 'drizzle-orm';
import {
  submitCorrectiveActionRequestSchema,
  type CorrectiveActionStatus,
  type CorrectiveOption,
} from '@audit5s/contracts';
import { awaitsResponse, submissionTarget } from '@audit5s/domain';
import type { LocalDatabase } from './local-database';
import { enqueue, uuidv7 } from './audit.repository';
import { captureLocalEvidence } from './evidence.repository';
import { localCorrectiveActions, localCorrectiveSubmissions } from './schema';

/**
 * The Zone Leader's corrective actions on the device (§2.4 steps 5–9, §9.2).
 *
 * An attempt is saved when SQLite commits, like an answer or a photograph: a local
 * submission row plus a `submit` item on the data queue. The sync engine sorts that item
 * after the commit of the after-photo it cites (`sortSyncItems`), so Option A reaches the
 * server in the only order the server accepts.
 */

export type CachedAction = typeof localCorrectiveActions.$inferSelect;

export interface LocalAction extends CachedAction {
  /** What the action is from this device's point of view: its pending attempt wins. */
  effectiveStatus: CorrectiveActionStatus;
  pendingSubmissionId: string | null;
}

export async function listLocalCorrectiveActions(database: LocalDatabase): Promise<LocalAction[]> {
  const actions = await database
    .select()
    .from(localCorrectiveActions)
    .orderBy(asc(localCorrectiveActions.dueAt), asc(localCorrectiveActions.zoneCode));
  const pending = await database.select().from(localCorrectiveSubmissions);
  const byAction = new Map(pending.map((attempt) => [attempt.correctiveActionId, attempt]));

  return actions.map((action) => {
    const attempt = byAction.get(action.id);
    return {
      ...action,
      effectiveStatus: (attempt?.targetStatus ?? action.status) as CorrectiveActionStatus,
      pendingSubmissionId: attempt?.id ?? null,
    };
  });
}

export async function getLocalCorrectiveAction(
  database: LocalDatabase,
  actionId: string,
): Promise<LocalAction | null> {
  return (await listLocalCorrectiveActions(database)).find((action) => action.id === actionId) ?? null;
}

/**
 * The Option A photograph, keyed to the attempt the form minted (§5.6). It rides the media
 * queue like every other photograph; the server scopes it by the action (R-13).
 */
export async function captureAfterPhoto(
  database: LocalDatabase,
  input: {
    action: Pick<CachedAction, 'id' | 'auditId'>;
    submissionId: string;
    localFileUri: string;
    byteSize: number;
    checksumSha256: string;
    width?: number | null;
    height?: number | null;
    location?: { latitude: number; longitude: number; accuracyM?: number | null; provider?: string } | null;
    now?: string;
  },
): Promise<string> {
  return captureLocalEvidence(database, {
    auditId: input.action.auditId,
    kind: 'CORRECTIVE_AFTER',
    correctiveActionId: input.action.id,
    correctiveActionSubmissionId: input.submissionId,
    localFileUri: input.localFileUri,
    byteSize: input.byteSize,
    checksumSha256: input.checksumSha256,
    width: input.width ?? null,
    height: input.height ?? null,
    isLiveCapture: true,
    location: input.location ?? null,
    ...(input.now ? { now: input.now } : {}),
  });
}

/**
 * One attempt, saved locally and queued (§7.3). Validated with the **server's** schema
 * before anything is written, so a form the server would refuse is refused here instead of
 * dead-lettering later.
 */
export async function submitLocalCorrectiveAction(
  database: LocalDatabase,
  input: {
    actionId: string;
    submissionId?: string;
    option: CorrectiveOption;
    submittedByName?: string;
    description?: string;
    explanation?: string;
    afterEvidenceId?: string;
    now?: string;
  },
): Promise<string> {
  const action = await getLocalCorrectiveAction(database, input.actionId);
  if (!action) throw new Error('This corrective action is not on the device.');
  if (!awaitsResponse(action.effectiveStatus)) {
    throw new Error('This corrective action is not waiting for a response.');
  }

  const id = input.submissionId ?? uuidv7();
  const now = input.now ?? new Date().toISOString();
  const body = submitCorrectiveActionRequestSchema.parse(
    input.option === 'COMPLETED'
      ? {
          option: 'COMPLETED',
          id,
          submittedByName: input.submittedByName,
          description: input.description,
          afterEvidenceId: input.afterEvidenceId,
        }
      : { option: 'NOT_POSSIBLE', id, explanation: input.explanation },
  );

  await database.insert(localCorrectiveSubmissions).values({
    id,
    correctiveActionId: action.id,
    option: body.option,
    targetStatus: submissionTarget(body.option),
    afterEvidenceId: body.option === 'COMPLETED' ? body.afterEvidenceId : null,
    createdAt: now,
  });

  await enqueue(
    database,
    'corrective_action_submission',
    id,
    'submit',
    { ...body, correctiveActionId: action.id },
    now,
  );
  return id;
}

/**
 * The server has the attempt (§9.3's ACCEPTED/DUPLICATE): the local row goes (R-4), and the
 * cached action shows what the server now holds until the next catalogue says so itself.
 */
export async function confirmLocalSubmission(database: LocalDatabase, submissionId: string): Promise<void> {
  const [attempt] = await database
    .select()
    .from(localCorrectiveSubmissions)
    .where(eq(localCorrectiveSubmissions.id, submissionId))
    .limit(1);
  if (!attempt) return;
  await database
    .update(localCorrectiveActions)
    .set({ status: attempt.targetStatus })
    .where(eq(localCorrectiveActions.id, attempt.correctiveActionId));
  await database.delete(localCorrectiveSubmissions).where(eq(localCorrectiveSubmissions.id, submissionId));
}

/** Quarantined server-side (§9.3 CONFLICT): settled here, and the catalogue decides. */
export async function settleLocalSubmission(database: LocalDatabase, submissionId: string): Promise<void> {
  await database.delete(localCorrectiveSubmissions).where(eq(localCorrectiveSubmissions.id, submissionId));
}

/** The words a Zone Leader sees for an action's state, pending attempt first. */
export function statusLabel(action: LocalAction): string {
  if (action.pendingSubmissionId) return 'Waiting to sync';
  switch (action.effectiveStatus) {
    case 'OPEN':
      return 'Open';
    case 'REOPENED':
      return 'Reopened';
    case 'ACTION_SUBMITTED':
      return 'Submitted';
    case 'NOT_POSSIBLE':
      return 'Not possible';
    case 'VERIFIED':
      return 'Verified';
    case 'WITHDRAWN':
      // R-31: the auditor corrected the mark this rested on, so there is nothing to do.
      // Said plainly, because a Zone Leader who walked to the Zone deserves to know why.
      return 'Withdrawn';
  }
}
