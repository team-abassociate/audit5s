import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { EvidenceClassification, EvidenceKind, ResponseValue } from '@audit5s/contracts';
import { classifyEvidence } from '@audit5s/domain';
import type { LocalDatabase } from './local-database';
import {
  audits,
  localAuditZones,
  localEvidence,
  localQuestionResponses,
  outbox,
} from './schema';
import { ZONE_PHOTO_LIMIT, ZONE_PHOTO_LIMIT_MESSAGE, isZoneAuditPhoto } from './photo-limit';
import { enqueue, uuidv7 } from './audit.repository';

/**
 * The device's evidence store (§9.1, §9.4).
 *
 * A photograph follows the same rule as an answer: **it is saved when SQLite commits**,
 * not when the server hears about it. The row, the outbox item and the Zone's status
 * change all happen in one write path, so an app killed a millisecond after the shutter
 * has the photo and the queue entry or neither.
 *
 * Two outbox rows per photo, not one — that is §9.4's two-phase commit made concrete:
 *
 *   `evidence:upsert` on the **media** queue — the metadata row and the presigned PUT;
 *   `evidence:commit` on the **data** queue — the confirmation, after the bytes land.
 *
 * The classification is computed here with the same `classifyEvidence` the server runs, so
 * the green tick or the yellow warning the auditor sees the instant they take the photo is
 * the one the report will print. The server re-derives it and wins (E-1); they agree
 * because it is one function and not two implementations of one rule.
 */

export interface CaptureEvidenceInput {
  auditId: string;
  kind: EvidenceKind;
  auditZoneId?: string | null;
  questionResponseId?: string | null;
  /** `CORRECTIVE_AFTER` only: the action and the attempt the photograph is for (R-13). */
  correctiveActionId?: string | null;
  correctiveActionSubmissionId?: string | null;
  /** The downscaled, EXIF-stripped file this device wrote. */
  localFileUri: string;
  byteSize: number;
  checksumSha256: string;
  contentType?: string;
  width?: number | null;
  height?: number | null;
  /** The answer as it stands now, for E-1. Null when the question is unanswered. */
  scoreAtCapture?: ResponseValue | null;
  /** Honoured for `WALK_BY_PHOTO` only (§2.7); ignored on every other kind. */
  classification?: EvidenceClassification | null;
  remark?: string | null;
  /** False for a gallery pick (scored and walk-by photos may be one, 2026-10-13). */
  isLiveCapture?: boolean;
  id?: string;
  now?: string;
}

export async function assertZonePhotoLimitForCompletion(database: LocalDatabase, auditZoneId: string): Promise<void> {
  const photos = await listLocalEvidenceForZone(database, auditZoneId);
  const count = photos.filter((photo) => isZoneAuditPhoto(photo.kind)).length;
  if (count > ZONE_PHOTO_LIMIT) {
    throw new Error(`This Zone has ${count} photos. Remove ${count - ZONE_PHOTO_LIMIT} photos before submitting (maximum 25).`);
  }
}

export async function assertZonePhotoCapacity(database: LocalDatabase, auditZoneId: string): Promise<void> {
  const photos = await listLocalEvidenceForZone(database, auditZoneId);
  if (photos.filter((photo) => isZoneAuditPhoto(photo.kind)).length >= ZONE_PHOTO_LIMIT) {
    throw new Error(ZONE_PHOTO_LIMIT_MESSAGE);
  }
}

/** Captures a photograph. Returns the id the server will share (D12). */
export async function captureLocalEvidence(
  database: LocalDatabase,
  input: CaptureEvidenceInput,
): Promise<string> {
  if (input.auditZoneId && isZoneAuditPhoto(input.kind)) {
    await assertZonePhotoCapacity(database, input.auditZoneId);
  }
  const id = input.id ?? uuidv7();
  const now = input.now ?? new Date().toISOString();

  const classification = classifyEvidence({
    kind: input.kind,
    scoreAtCapture: input.scoreAtCapture ?? null,
    auditorSelected: input.classification ?? null,
  });

  await database.insert(localEvidence).values({
    id,
    kind: input.kind,
    auditId: input.auditId,
    auditZoneId: input.auditZoneId ?? null,
    questionResponseId: input.questionResponseId ?? null,
    localFileUri: input.localFileUri,
    contentType: input.contentType ?? 'image/jpeg',
    byteSize: input.byteSize,
    width: input.width ?? null,
    height: input.height ?? null,
    checksumSha256: input.checksumSha256,
    scoreAtCapture: input.scoreAtCapture ?? null,
    classification,
    remark: input.remark ?? null,
    isLiveCapture: (input.isLiveCapture ?? true) ? 1 : 0,
    // No location is read or recorded (dropped 2026-09-29); the columns stay, always null.
    latitude: null,
    longitude: null,
    accuracyM: null,
    locationProvider: null,
    capturedAt: now,
    clientUpdatedAt: now,
  });

  // §7.2: a walk-by Zone moves off DRAFT on the first photograph, the way a scored Zone
  // moves off it on the first answer. Without this the Zone could never be finished.
  // The auditee's photo is taken before the Zone starts, so it moves nothing (R-72).
  if (input.auditZoneId && input.kind !== 'AUDITEE_PHOTO') {
    await database
      .update(localAuditZones)
      .set({
        status: 'IN_PROGRESS',
        startedAt: sql`COALESCE(${localAuditZones.startedAt}, ${now})`,
        clientUpdatedAt: now,
      })
      .where(
        and(eq(localAuditZones.id, input.auditZoneId), eq(localAuditZones.status, 'DRAFT')),
      );
  }

  await database
    .update(audits)
    .set({ clientUpdatedAt: now })
    .where(eq(audits.id, input.auditId));

  // The metadata half, on the media queue: large binary, uploaded in parallel and
  // Wi-Fi-preferred, rather than in the small ordered JSON batch (§9.3).
  await enqueue(
    database,
    'evidence',
    id,
    'upsert',
    {
      id,
      kind: input.kind,
      auditId: input.auditId,
      ...(input.auditZoneId ? { auditZoneId: input.auditZoneId } : {}),
      ...(input.questionResponseId ? { questionResponseId: input.questionResponseId } : {}),
      ...(input.correctiveActionId ? { correctiveActionId: input.correctiveActionId } : {}),
      ...(input.correctiveActionSubmissionId
        ? { correctiveActionSubmissionId: input.correctiveActionSubmissionId }
        : {}),
      contentType: input.contentType ?? 'image/jpeg',
      byteSize: input.byteSize,
      checksumSha256: input.checksumSha256,
      capturedAt: now,
      isLiveCapture: input.isLiveCapture ?? true,
      ...(input.kind === 'WALK_BY_PHOTO' && input.classification
        ? { classification: input.classification }
        : {}),
      ...(input.remark ? { remark: input.remark } : {}),
    },
    now,
    // The selfie first (owner, 2026-10-24): it is what lets the server start the audit, so
    // it goes out ahead of every other photograph the moment there is any signal.
    { queue: 'media', priority: input.kind === 'AUDITOR_SELFIE' ? 100 : 200 },
  );

  return id;
}

/**
 * Where each audit's selfie stands (owner, 2026-10-24): on the server, on its way, or failed
 * for good. §7.1 starts the audit on the server only once a selfie arrives, and a lost one
 * left the 21 Sep 2026 audit waiting a month with the auditor none the wiser.
 *
 * Per audit, the best of its selfies wins — a retake that arrived outranks the one that
 * failed. FAILED means its upload or commit is dead-lettered; a retry in backoff is PENDING.
 * An audit with no selfie row on this phone (one pulled from the server) is absent.
 */
export type SelfieStatus = 'CONFIRMED' | 'PENDING' | 'FAILED';

const SELFIE_RANK: Record<SelfieStatus, number> = { FAILED: 0, PENDING: 1, CONFIRMED: 2 };

export async function selfieStatuses(database: LocalDatabase): Promise<Map<string, SelfieStatus>> {
  const selfies = await database
    .select({ id: localEvidence.id, auditId: localEvidence.auditId, syncState: localEvidence.syncState })
    .from(localEvidence)
    .where(and(eq(localEvidence.kind, 'AUDITOR_SELFIE'), isNull(localEvidence.deletedAt)));
  const dead = new Set(
    (
      await database
        .select({ id: outbox.entityId })
        .from(outbox)
        .where(and(eq(outbox.entityType, 'evidence'), eq(outbox.state, 'DEAD_LETTER')))
    ).map((row) => row.id),
  );

  const statuses = new Map<string, SelfieStatus>();
  for (const selfie of selfies) {
    const status: SelfieStatus =
      selfie.syncState === 'SYNCED' ? 'CONFIRMED' : dead.has(selfie.id) ? 'FAILED' : 'PENDING';
    const prior = statuses.get(selfie.auditId);
    if (!prior || SELFIE_RANK[status] > SELFIE_RANK[prior]) statuses.set(selfie.auditId, status);
  }
  return statuses;
}

/**
 * A new live selfie for an audit whose first one has not reached the server. The old one is
 * withdrawn the way any photograph is (`deleteLocalEvidence`), so only the retake uploads; the
 * answers are untouched. The audit's finish already waits for photos still queued, so it now
 * waits for this one.
 */
export async function retakeLocalSelfie(
  database: LocalDatabase,
  auditId: string,
  image: Pick<CaptureEvidenceInput, 'localFileUri' | 'byteSize' | 'width' | 'height' | 'checksumSha256'>,
): Promise<string> {
  const unsent = await database
    .select({ id: localEvidence.id })
    .from(localEvidence)
    .where(
      and(
        eq(localEvidence.auditId, auditId),
        eq(localEvidence.kind, 'AUDITOR_SELFIE'),
        isNull(localEvidence.deletedAt),
        sql`${localEvidence.syncState} <> 'SYNCED'`,
      ),
    );
  for (const row of unsent) await deleteLocalEvidence(database, row.id);
  return captureLocalEvidence(database, { ...image, auditId, kind: 'AUDITOR_SELFIE' });
}

/** Records the key `upload-intent` minted, so a retry can find the object again. */
export async function markEvidenceIntentIssued(
  database: LocalDatabase,
  evidenceId: string,
  objectKey: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  await database
    .update(localEvidence)
    .set({ objectKey, syncState: 'SYNCING', clientUpdatedAt: now })
    .where(eq(localEvidence.id, evidenceId));
}

/**
 * Queues the commit once the bytes are up (§9.4).
 *
 * Enqueued as a separate outbox item rather than called inline, so an app killed between
 * the PUT and the confirmation finds the commit still pending and replays it — which is
 * exactly §9.6's recovery path, and the reason `commit` is idempotent server-side.
 */
export async function queueEvidenceCommit(
  database: LocalDatabase,
  evidenceId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  const [row] = await database
    .select()
    .from(localEvidence)
    .where(eq(localEvidence.id, evidenceId))
    .limit(1);

  if (!row) return;

  await enqueue(
    database,
    'evidence',
    evidenceId,
    'commit',
    {
      checksumSha256: row.checksumSha256,
      ...(row.width ? { width: row.width } : {}),
      ...(row.height ? { height: row.height } : {}),
    },
    now,
  );
}

export async function markEvidenceSynced(
  database: LocalDatabase,
  evidenceId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  await database
    .update(localEvidence)
    .set({ syncState: 'SYNCED', uploadedAt: now, clientUpdatedAt: now })
    .where(eq(localEvidence.id, evidenceId));
}

export async function recordUploadAttempt(
  database: LocalDatabase,
  evidenceId: string,
): Promise<void> {
  await database
    .update(localEvidence)
    .set({ uploadAttempts: sql`${localEvidence.uploadAttempts} + 1` })
    .where(eq(localEvidence.id, evidenceId));
}

/**
 * Deletes a photograph before completion (E-4).
 *
 * §9.4: "Outbox media row cancelled if still `PENDING`; if `SYNCED`, `DELETE /evidence/{id}`
 * soft-deletes server-side." Both halves are here — a photo the server has never heard of
 * simply stops being queued, and one it knows about gets a delete item. The local row is
 * soft-deleted either way, because the device never hard-deletes audit data either.
 */
export async function deleteLocalEvidence(
  database: LocalDatabase,
  evidenceId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  const [row] = await database
    .select()
    .from(localEvidence)
    .where(eq(localEvidence.id, evidenceId))
    .limit(1);

  if (!row || row.deletedAt) return;

  await database
    .update(localEvidence)
    .set({ deletedAt: now, isSummaryFlagged: 0, clientUpdatedAt: now })
    .where(eq(localEvidence.id, evidenceId));

  // Never uploaded: cancel the queued metadata rather than telling the server about a
  // photograph it has no row for and will never see.
  await database
    .delete(outbox)
    .where(and(eq(outbox.entityType, 'evidence'), eq(outbox.entityId, evidenceId)));

  if (row.objectKey) {
    await enqueue(database, 'evidence', evidenceId, 'delete', { id: evidenceId }, now);
  }
}

/**
 * The summary flag (§5.6), enforced locally as well as in the database.
 *
 * The local check is an affordance, not the control: the two partial unique indexes on the
 * server are what make "one flagged GOOD and one flagged NONCONFORMITY per Zone" survive a
 * duplicated sync. Doing it here too means the auditor finds out at the tap rather than
 * three hours later when the queue drains.
 */
export async function setLocalSummaryFlag(
  database: LocalDatabase,
  evidenceId: string,
  flagged: boolean,
  now: string = new Date().toISOString(),
): Promise<{ ok: true } | { ok: false; reason: 'TAKEN' | 'NEUTRAL' }> {
  const [row] = await database
    .select()
    .from(localEvidence)
    .where(eq(localEvidence.id, evidenceId))
    .limit(1);

  if (!row) return { ok: false, reason: 'NEUTRAL' };

  if (flagged) {
    // E-3: a NEUTRAL photo has no report section to be the summary of.
    if (row.classification !== 'GOOD' && row.classification !== 'NONCONFORMITY') {
      return { ok: false, reason: 'NEUTRAL' };
    }

    const clash = await database
      .select({ id: localEvidence.id })
      .from(localEvidence)
      .where(
        and(
          eq(localEvidence.auditZoneId, row.auditZoneId ?? ''),
          eq(localEvidence.classification, row.classification),
          eq(localEvidence.isSummaryFlagged, 1),
          isNull(localEvidence.deletedAt),
        ),
      );

    if (clash.some((other) => other.id !== evidenceId)) {
      return { ok: false, reason: 'TAKEN' };
    }
  }

  await database
    .update(localEvidence)
    .set({ isSummaryFlagged: flagged ? 1 : 0, clientUpdatedAt: now })
    .where(eq(localEvidence.id, evidenceId));

  await queueEvidencePatch(database, evidenceId, now);

  return { ok: true };
}

/** A photograph's own remark, written in its preview; the reports print it under the photo. */
export async function setLocalEvidenceRemark(
  database: LocalDatabase,
  evidenceId: string,
  remark: string | null,
  now: string = new Date().toISOString(),
): Promise<void> {
  await database
    .update(localEvidence)
    .set({ remark, clientUpdatedAt: now })
    .where(eq(localEvidence.id, evidenceId));
  await queueEvidencePatch(database, evidenceId, now);
}

/** Updates the fields an auditor may change after taking a walk-by photograph. */
export async function updateLocalWalkByEvidence(
  database: LocalDatabase,
  evidenceId: string,
  patch: { classification?: EvidenceClassification; remark?: string | null },
  now: string = new Date().toISOString(),
): Promise<{ ok: true } | { ok: false; reason: 'TAKEN' }> {
  const [row] = await getLocalEvidence(database, evidenceId);
  if (!row || row.kind !== 'WALK_BY_PHOTO') {
    throw new Error('Only walk-by photographs can be re-judged');
  }

  const classification = patch.classification ?? (row.classification as EvidenceClassification);
  if (
    row.isSummaryFlagged === 1 &&
    classification !== row.classification &&
    classification !== 'NEUTRAL' &&
    (await summaryFlagTaken(database, row.auditZoneId, classification, evidenceId))
  ) {
    return { ok: false, reason: 'TAKEN' };
  }

  await database
    .update(localEvidence)
    .set({
      ...(patch.classification !== undefined ? { classification } : {}),
      ...(patch.remark !== undefined ? { remark: patch.remark } : {}),
      ...(classification === 'NEUTRAL' ? { isSummaryFlagged: 0 } : {}),
      clientUpdatedAt: now,
    })
    .where(eq(localEvidence.id, evidenceId));

  await queueEvidencePatch(database, evidenceId, now);
  return { ok: true };
}

/**
 * E-2 on the device: a changed answer re-files its photographs.
 *
 * The server does this authoritatively inside the response transaction. The device does it
 * so the badge under the question is right *before* the sync — an auditor who marks a
 * question down and still sees a green tick has been told something false.
 */
export async function reclassifyLocalEvidence(
  database: LocalDatabase,
  questionResponseId: string,
  value: ResponseValue,
  now: string = new Date().toISOString(),
): Promise<void> {
  const classification = classifyEvidence({
    kind: 'QUESTION_EVIDENCE',
    scoreAtCapture: value,
  });

  await database
    .update(localEvidence)
    .set({
      classification,
      scoreAtCapture: value,
      // E-3: the flag cannot survive a move to NEUTRAL.
      ...(classification === 'NEUTRAL' ? { isSummaryFlagged: 0 } : {}),
      clientUpdatedAt: now,
    })
    .where(
      and(
        eq(localEvidence.questionResponseId, questionResponseId),
        isNull(localEvidence.deletedAt),
      ),
    );
}

// ------------------------------------------------------------------------------ reads

/** The Zone's audit photos. Not the auditee's (R-72): it is no finding, and no walk-by photo. */
export function listLocalEvidenceForZone(database: LocalDatabase, auditZoneId: string) {
  return database
    .select()
    .from(localEvidence)
    .where(
      and(
        eq(localEvidence.auditZoneId, auditZoneId),
        ne(localEvidence.kind, 'AUDITEE_PHOTO'),
        isNull(localEvidence.deletedAt),
      ),
    )
    .orderBy(asc(localEvidence.capturedAt));
}

/** R-72: the photo of whoever faced the audit of this Zone, if this phone took one. */
export async function getLocalAuditeePhoto(database: LocalDatabase, auditZoneId: string) {
  const [row] = await database
    .select()
    .from(localEvidence)
    .where(
      and(
        eq(localEvidence.auditZoneId, auditZoneId),
        eq(localEvidence.kind, 'AUDITEE_PHOTO'),
        isNull(localEvidence.deletedAt),
      ),
    )
    .orderBy(asc(localEvidence.capturedAt))
    .limit(1);
  return row ?? null;
}

export function listLocalEvidenceForAudit(database: LocalDatabase, auditId: string) {
  return database
    .select()
    .from(localEvidence)
    .where(and(eq(localEvidence.auditId, auditId), isNull(localEvidence.deletedAt)))
    .orderBy(asc(localEvidence.capturedAt));
}

export function getLocalEvidence(database: LocalDatabase, evidenceId: string) {
  return database.select().from(localEvidence).where(eq(localEvidence.id, evidenceId)).limit(1);
}

/**
 * The response a question already has in this Zone, if any.
 *
 * A photograph taken *before* the answer has no response to link to — and that is allowed:
 * E-1 files it NEUTRAL until the answer lands, and E-2 re-files it then. So this returns
 * null rather than refusing the capture, because an auditor who photographs first and
 * judges second is doing the job in the order the job happens.
 */
export async function responseIdFor(
  database: LocalDatabase,
  auditZoneId: string,
  checklistQuestionId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ id: localQuestionResponses.id })
    .from(localQuestionResponses)
    .where(
      and(
        eq(localQuestionResponses.auditZoneId, auditZoneId),
        eq(localQuestionResponses.checklistQuestionId, checklistQuestionId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** The §7.1 selfie gate, answered locally so the start screen works with the radio off. */
export async function hasLocalSelfie(
  database: LocalDatabase,
  auditId: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: localEvidence.id })
    .from(localEvidence)
    .where(
      and(
        eq(localEvidence.auditId, auditId),
        eq(localEvidence.kind, 'AUDITOR_SELFIE'),
        eq(localEvidence.isLiveCapture, 1),
        isNull(localEvidence.deletedAt),
      ),
    );
  return rows.length > 0;
}

/** The §7.2 walk-by gate: at least one photograph in the Zone. */
export async function zoneHasLocalEvidence(
  database: LocalDatabase,
  auditZoneId: string,
): Promise<boolean> {
  const rows = await listLocalEvidenceForZone(database, auditZoneId);
  return rows.length > 0;
}

/** The photo count the sync affordance shows separately from the item count (§9.9). */
export async function pendingPhotoCount(database: LocalDatabase): Promise<number> {
  const rows = await database
    .select({ id: localEvidence.id })
    .from(localEvidence)
    .where(and(sql`${localEvidence.syncState} <> 'SYNCED'`, isNull(localEvidence.deletedAt)));
  return rows.length;
}

/** Coalesced patch payload: later edits keep earlier offline changes instead of replacing them. */
async function queueEvidencePatch(
  database: LocalDatabase,
  evidenceId: string,
  now: string,
): Promise<void> {
  const [row] = await getLocalEvidence(database, evidenceId);
  if (!row) return;

  await enqueue(database, 'evidence', evidenceId, 'patch', {
    remark: row.remark,
    isSummaryFlagged: row.isSummaryFlagged === 1,
    ...(row.kind === 'WALK_BY_PHOTO' ? { classification: row.classification } : {}),
  }, now);
}

async function summaryFlagTaken(
  database: LocalDatabase,
  auditZoneId: string | null,
  classification: EvidenceClassification,
  evidenceId: string,
): Promise<boolean> {
  if (!auditZoneId) return false;
  const rows = await database
    .select({ id: localEvidence.id })
    .from(localEvidence)
    .where(
      and(
        eq(localEvidence.auditZoneId, auditZoneId),
        eq(localEvidence.classification, classification),
        eq(localEvidence.isSummaryFlagged, 1),
        isNull(localEvidence.deletedAt),
      ),
    );
  return rows.some((row) => row.id !== evidenceId);
}
