import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  createKaizenRequestSchema,
  kaizenPhotoUploadIntentRequestSchema,
  type Kaizen,
  type KaizenFields,
  type KaizenPhotoKind,
  type KaizenStatus,
} from '@audit5s/contracts';
import { missingKaizenFields } from '@audit5s/domain';
import type { LocalDatabase } from './local-database';
import { enqueue, uuidv7 } from './audit.repository';
import { UNSETTLED_STATES } from './outbox.repository';
import { localKaizenPhotos, localKaizenSubmissions, localKaizens, outbox } from './schema';

/**
 * A Zone Leader's Kaizens on the device (R-48, plans/kaizen-module.md step 4).
 *
 * Saved when SQLite commits, like an answer: each write is the row plus its outbox item.
 *
 *   - the sheet → `kaizen:upsert`, carrying the **whole** sheet (the outbox coalesces, and
 *     the server replaces an unsynced payload whole);
 *   - a photo → `kaizen_photo:upsert` on the media queue, then `commit` once the PUT lands;
 *   - Submit → `kaizen_submission:submit`, with a fresh id per submission so a late replay
 *     cannot resubmit a Kaizen the Coordinator has since sent back.
 *
 * Every payload names its `kaizenId`, which is how `refreshLocalKaizens` knows not to
 * overwrite a Kaizen that still has anything unsent.
 */

export type LocalKaizenRow = typeof localKaizens.$inferSelect;
export type LocalKaizenPhoto = typeof localKaizenPhotos.$inferSelect;

export interface LocalKaizen extends Omit<LocalKaizenRow, 'sheet' | 'status'> {
  sheet: KaizenFields;
  /** What the Kaizen is from this device's point of view: a pending Submit wins. */
  status: KaizenStatus;
  pendingSubmissionId: string | null;
}

/** Only these may be edited or submitted (`KAIZEN_TRANSITIONS`). */
const EDITABLE: readonly KaizenStatus[] = ['DRAFT', 'SENT_BACK'];

export async function listLocalKaizens(database: LocalDatabase): Promise<LocalKaizen[]> {
  const rows = await database.select().from(localKaizens).orderBy(desc(localKaizens.updatedAt));
  const pending = await database.select().from(localKaizenSubmissions);
  const byKaizen = new Map(pending.map((submission) => [submission.kaizenId, submission.id]));
  return rows.map((row) => {
    const pendingSubmissionId = byKaizen.get(row.id) ?? null;
    return {
      ...row,
      sheet: JSON.parse(row.sheet) as KaizenFields,
      status: pendingSubmissionId ? 'SUBMITTED' : (row.status as KaizenStatus),
      pendingSubmissionId,
    };
  });
}

export async function getLocalKaizen(database: LocalDatabase, kaizenId: string): Promise<LocalKaizen | null> {
  return (await listLocalKaizens(database)).find((kaizen) => kaizen.id === kaizenId) ?? null;
}

/** The module picker's Kaizen line: what is waiting on the leader. */
export async function localKaizenCounts(
  database: LocalDatabase,
): Promise<{ sentBack: number; drafts: number }> {
  const kaizens = await listLocalKaizens(database);
  return {
    sentBack: kaizens.filter((kaizen) => kaizen.status === 'SENT_BACK').length,
    drafts: kaizens.filter((kaizen) => kaizen.status === 'DRAFT').length,
  };
}

/** A new DRAFT in the leader's Zone. The Zone is fixed here: the number carries its code. */
export async function createLocalKaizen(
  database: LocalDatabase,
  input: {
    unitId: string;
    zone: { id: string; code: string; name: string };
    sheet?: KaizenFields;
    now?: string;
  },
): Promise<string> {
  const id = uuidv7();
  const now = input.now ?? new Date().toISOString();
  const sheet = input.sheet ?? {};
  const payload = upsertPayload(id, input.zone.id, sheet);

  await database.insert(localKaizens).values({
    id,
    unitId: input.unitId,
    zoneId: input.zone.id,
    zoneCode: input.zone.code,
    zoneName: input.zone.name,
    sheet: JSON.stringify(sheet),
    createdAt: now,
    updatedAt: now,
  });
  await enqueue(database, 'kaizen', id, 'upsert', payload, now);
  return id;
}

/** One or more fields, merged into the sheet and queued with the rest of it. */
export async function saveLocalKaizenFields(
  database: LocalDatabase,
  kaizenId: string,
  fields: KaizenFields,
  now: string = new Date().toISOString(),
): Promise<void> {
  const kaizen = await editableKaizen(database, kaizenId);
  const sheet = { ...kaizen.sheet, ...fields };
  const payload = upsertPayload(kaizenId, kaizen.zoneId, sheet);

  await database
    .update(localKaizens)
    .set({ sheet: JSON.stringify(sheet), updatedAt: now })
    .where(eq(localKaizens.id, kaizenId));
  await enqueue(database, 'kaizen', kaizenId, 'upsert', payload, now);
}

/** The live photo of one kind, if any. */
export async function getLocalKaizenPhoto(
  database: LocalDatabase,
  kaizenId: string,
  kind: KaizenPhotoKind,
): Promise<LocalKaizenPhoto | null> {
  const [photo] = await database
    .select()
    .from(localKaizenPhotos)
    .where(
      and(
        eq(localKaizenPhotos.kaizenId, kaizenId),
        eq(localKaizenPhotos.kind, kind),
        isNull(localKaizenPhotos.deletedAt),
      ),
    )
    .limit(1);
  return photo ?? null;
}

/**
 * A before or after photo, already downscaled by the capture pipeline. Replaces the live one
 * of the same kind: the server holds one per kind, so the old one is removed first.
 */
export async function addLocalKaizenPhoto(
  database: LocalDatabase,
  input: {
    kaizenId: string;
    kind: KaizenPhotoKind;
    localFileUri: string;
    byteSize: number;
    checksumSha256: string;
    width?: number | null;
    height?: number | null;
    /** False for a photo chosen from the gallery, which Kaizen allows (R-48). */
    isLiveCapture: boolean;
    now?: string;
  },
): Promise<string> {
  await editableKaizen(database, input.kaizenId);
  const now = input.now ?? new Date().toISOString();
  const id = uuidv7();
  // Validated with the server's schema first, so a photo it would refuse never queues.
  const intent = kaizenPhotoUploadIntentRequestSchema.parse({
    id,
    kaizenId: input.kaizenId,
    kind: input.kind,
    contentType: 'image/jpeg',
    byteSize: input.byteSize,
    checksumSha256: input.checksumSha256,
    capturedAt: now,
    isLiveCapture: input.isLiveCapture,
  });

  const previous = await getLocalKaizenPhoto(database, input.kaizenId, input.kind);
  if (previous) await removeLocalKaizenPhoto(database, previous.id, now);

  await database.insert(localKaizenPhotos).values({
    id,
    kaizenId: input.kaizenId,
    kind: input.kind,
    localFileUri: input.localFileUri,
    byteSize: input.byteSize,
    width: input.width ?? null,
    height: input.height ?? null,
    checksumSha256: input.checksumSha256,
    isLiveCapture: input.isLiveCapture ? 1 : 0,
    capturedAt: now,
  });
  await enqueue(database, 'kaizen_photo', id, 'upsert', intent, now, { queue: 'media' });
  await touch(database, input.kaizenId, now);
  return id;
}

/**
 * Removes a photo. One that never left the phone just has its upload cancelled; one the
 * server may already hold is deleted there too (nothing is hard-deleted on either side).
 */
export async function removeLocalKaizenPhoto(
  database: LocalDatabase,
  photoId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  const [photo] = await database.select().from(localKaizenPhotos).where(eq(localKaizenPhotos.id, photoId)).limit(1);
  if (!photo || photo.deletedAt) return;
  await editableKaizen(database, photo.kaizenId);

  await database.update(localKaizenPhotos).set({ deletedAt: now }).where(eq(localKaizenPhotos.id, photoId));
  const queued = await database
    .select({ operation: outbox.operation })
    .from(outbox)
    .where(and(eq(outbox.entityType, 'kaizen_photo'), eq(outbox.entityId, photoId)));
  await database
    .delete(outbox)
    .where(and(eq(outbox.entityType, 'kaizen_photo'), eq(outbox.entityId, photoId)));

  // Still waiting for its intent ⇒ the server has never heard of it.
  const neverSent = queued.some((item) => item.operation === 'upsert') && photo.objectKey === null;
  if (!neverSent) {
    await enqueue(database, 'kaizen_photo', photoId, 'delete', { kaizenId: photo.kaizenId }, now);
  }
  await touch(database, photo.kaizenId, now);
}

/** Submit, refused here for what the server would refuse: a missing required field. */
export async function submitLocalKaizen(
  database: LocalDatabase,
  kaizenId: string,
  now: string = new Date().toISOString(),
): Promise<string> {
  const kaizen = await editableKaizen(database, kaizenId);
  const missing = missingKaizenFields(kaizen.sheet);
  if (missing.length > 0) {
    throw new Error(`Fill in every required step first (${missing.length} left).`);
  }

  const id = uuidv7();
  await database.insert(localKaizenSubmissions).values({ id, kaizenId, createdAt: now });
  await enqueue(database, 'kaizen_submission', id, 'submit', { kaizenId }, now);
  return id;
}

// ------------------------------------------------------------------ the sync engine's

export async function getKaizenPhotoById(database: LocalDatabase, photoId: string) {
  const [photo] = await database.select().from(localKaizenPhotos).where(eq(localKaizenPhotos.id, photoId)).limit(1);
  return photo ?? null;
}

export async function markKaizenPhotoIntentIssued(
  database: LocalDatabase,
  photoId: string,
  objectKey: string,
): Promise<void> {
  await database.update(localKaizenPhotos).set({ objectKey }).where(eq(localKaizenPhotos.id, photoId));
}

/** Phase two of the upload, queued rather than called (§9.6): a kill here replays it. */
export async function queueKaizenPhotoCommit(database: LocalDatabase, photo: LocalKaizenPhoto): Promise<void> {
  await enqueue(database, 'kaizen_photo', photo.id, 'commit', {
    kaizenId: photo.kaizenId,
    checksumSha256: photo.checksumSha256,
    ...(photo.width ? { width: photo.width } : {}),
    ...(photo.height ? { height: photo.height } : {}),
  });
}

export async function markKaizenPhotoUploaded(
  database: LocalDatabase,
  photoId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  await database.update(localKaizenPhotos).set({ uploadedAt: now }).where(eq(localKaizenPhotos.id, photoId));
}

/** The server has the submission: the Kaizen is SUBMITTED until the next pull says more. */
export async function confirmLocalKaizenSubmission(
  database: LocalDatabase,
  submissionId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  const [submission] = await database
    .select()
    .from(localKaizenSubmissions)
    .where(eq(localKaizenSubmissions.id, submissionId))
    .limit(1);
  if (!submission) return;
  await database
    .update(localKaizens)
    .set({ status: 'SUBMITTED', submittedAt: sql`coalesce(${localKaizens.submittedAt}, ${now})`, updatedAt: now })
    .where(eq(localKaizens.id, submission.kaizenId));
  await settleLocalKaizenSubmission(database, submissionId);
}

/** Quarantined or refused server-side: the pull decides what the Kaizen is. */
export async function settleLocalKaizenSubmission(database: LocalDatabase, submissionId: string): Promise<void> {
  await database.delete(localKaizenSubmissions).where(eq(localKaizenSubmissions.id, submissionId));
}

/**
 * The server's copy of the leader's Kaizens (`GET /kaizens?mine=true`), written over the
 * local rows — except a Kaizen with anything still in the outbox, whose local copy is newer
 * by definition. That is the rule that keeps a pull from undoing an offline edit.
 */
export async function refreshLocalKaizens(database: LocalDatabase, kaizens: readonly Kaizen[]): Promise<void> {
  const busy = await kaizensWithUnsentWork(database);

  for (const kaizen of kaizens) {
    if (busy.has(kaizen.id)) continue;
    const row = {
      unitId: kaizen.unitId,
      zoneId: kaizen.zoneId,
      zoneCode: kaizen.zoneCode,
      zoneName: kaizen.zoneName,
      kaizenNo: kaizen.kaizenNo,
      sheet: JSON.stringify(sheetOf(kaizen)),
      status: kaizen.status,
      submittedAt: kaizen.submittedAt,
      reviewDecision: kaizen.latestReview?.decision ?? null,
      reviewComment: kaizen.latestReview?.comment ?? null,
      reviewedAt: kaizen.latestReview?.createdAt ?? null,
      updatedAt: kaizen.updatedAt,
    };
    await database
      .insert(localKaizens)
      .values({ id: kaizen.id, createdAt: kaizen.createdAt, ...row })
      .onConflictDoUpdate({ target: localKaizens.id, set: row });

    // A photo known only from the server: no file here, so a screen fetches its view URL.
    for (const photo of [kaizen.beforePhoto, kaizen.afterPhoto]) {
      if (!photo) continue;
      await database
        .insert(localKaizenPhotos)
        .values({
          id: photo.id,
          kaizenId: kaizen.id,
          kind: photo.kind,
          contentType: photo.contentType,
          byteSize: photo.byteSize,
          width: photo.width,
          height: photo.height,
          checksumSha256: photo.checksumSha256,
          isLiveCapture: photo.isLiveCapture ? 1 : 0,
          capturedAt: photo.capturedAt,
          uploadedAt: photo.uploadedAt,
        })
        .onConflictDoNothing();
    }
  }
}

// ---------------------------------------------------------------------------- helpers

async function editableKaizen(database: LocalDatabase, kaizenId: string): Promise<LocalKaizen> {
  const kaizen = await getLocalKaizen(database, kaizenId);
  if (!kaizen) throw new Error('This Kaizen is not on the device.');
  if (!EDITABLE.includes(kaizen.status)) {
    throw new Error('Only a draft or a Kaizen sent back to you can be changed.');
  }
  return kaizen;
}

function upsertPayload(id: string, zoneId: string, sheet: KaizenFields): Record<string, unknown> {
  // The server's schema, so a sheet it would refuse is refused before it is queued.
  const { id: _id, ...payload } = createKaizenRequestSchema.parse({ ...sheet, id, zoneId });
  void _id;
  return payload;
}

function touch(database: LocalDatabase, kaizenId: string, now: string) {
  return database.update(localKaizens).set({ updatedAt: now }).where(eq(localKaizens.id, kaizenId));
}

const SHEET_KEYS = [
  'machine', 'lineArea', 'implementedOn', 'teamMembers', 'theme', 'target', 'problem5w1h',
  'rootCause4m', 'analysis7qc', 'countermeasure', 'wastes', 'parameters',
  'horizontalDeployment', 'benefits', 'annualSaving', 'ideaBy', 'implementedBy',
] as const satisfies readonly (keyof KaizenFields)[];

function sheetOf(kaizen: Kaizen): KaizenFields {
  return Object.fromEntries(SHEET_KEYS.map((key) => [key, kaizen[key]])) as KaizenFields;
}

async function kaizensWithUnsentWork(database: LocalDatabase): Promise<Set<string>> {
  const rows = await database
    .select({ entityType: outbox.entityType, entityId: outbox.entityId, payload: outbox.payload })
    .from(outbox)
    .where(
      and(
        inArray(outbox.entityType, ['kaizen', 'kaizen_photo', 'kaizen_submission']),
        inArray(outbox.state, [...UNSETTLED_STATES]),
      ),
    );
  const pending = await database.select({ kaizenId: localKaizenSubmissions.kaizenId }).from(localKaizenSubmissions);
  return new Set([
    ...rows.map((row) =>
      row.entityType === 'kaizen' ? row.entityId : (JSON.parse(row.payload) as { kaizenId: string }).kaizenId,
    ),
    ...pending.map((row) => row.kaizenId),
  ]);
}
