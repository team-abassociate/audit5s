import { and, asc, eq, isNull, sql } from 'drizzle-orm';
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
  /** False only if a flow ever admits a gallery pick. None of these do (§12.10). */
  isLiveCapture?: boolean;
  location?: {
    latitude: number;
    longitude: number;
    accuracyM?: number | null;
    provider?: string;
  } | null;
  id?: string;
  now?: string;
}

/** Captures a photograph. Returns the id the server will share (D12). */
export async function captureLocalEvidence(
  database: LocalDatabase,
  input: CaptureEvidenceInput,
): Promise<string> {
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
    latitude: input.location?.latitude ?? null,
    longitude: input.location?.longitude ?? null,
    accuracyM: input.location?.accuracyM ?? null,
    locationProvider: input.location?.provider ?? null,
    capturedAt: now,
    clientUpdatedAt: now,
  });

  // §7.2: a walk-by Zone moves off DRAFT on the first photograph, the way a scored Zone
  // moves off it on the first answer. Without this the Zone could never be finished.
  if (input.auditZoneId) {
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
      contentType: input.contentType ?? 'image/jpeg',
      byteSize: input.byteSize,
      checksumSha256: input.checksumSha256,
      capturedAt: now,
      isLiveCapture: input.isLiveCapture ?? true,
      ...(input.kind === 'WALK_BY_PHOTO' && input.classification
        ? { classification: input.classification }
        : {}),
      ...(input.remark ? { remark: input.remark } : {}),
      ...(input.location
        ? {
            location: {
              latitude: input.location.latitude,
              longitude: input.location.longitude,
              accuracyM: input.location.accuracyM ?? null,
              provider: input.location.provider ?? 'UNKNOWN',
              capturedAt: now,
            },
          }
        : {}),
    },
    now,
    { queue: 'media', priority: 200 },
  );

  return id;
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

export function listLocalEvidenceForZone(database: LocalDatabase, auditZoneId: string) {
  return database
    .select()
    .from(localEvidence)
    .where(and(eq(localEvidence.auditZoneId, auditZoneId), isNull(localEvidence.deletedAt)))
    .orderBy(asc(localEvidence.capturedAt));
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
