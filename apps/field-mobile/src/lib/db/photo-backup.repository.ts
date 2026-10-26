import { and, eq, isNull } from 'drizzle-orm';
import type { LocalDatabase } from './local-database';
import { localEvidence, outbox, photoBackups } from './schema';

/** A photo with no copy in the backup folder yet. */
export interface PhotoToBackUp {
  evidenceId: string;
  localFileUri: string;
  contentType: string;
  checksumSha256: string;
  capturedAt: string;
  /**
   * The `upload-intent` body while the photo still waits to upload, for the recovery file
   * beside the copy; null once its bytes are up, when the copy is the auditor's alone.
   */
  payload: Record<string, unknown> | null;
}

export type BackupRow = typeof photoBackups.$inferSelect;

/**
 * What the backup folder needs this cycle, from this person's store alone (R-62).
 *
 * `write`: every live photo with a file and no copy yet. The copy is the auditor's to keep.
 * `settle`: copies whose photo is now on the server but whose recovery file is still there.
 * `drop`: copies of photos the auditor deleted or whose audit was aborted — both files go.
 * Copies this store never made are not here: someone else's, or left from before a
 * reinstall, and only recovery touches them.
 */
export async function planPhotoBackup(
  database: LocalDatabase,
): Promise<{ write: PhotoToBackUp[]; settle: BackupRow[]; drop: BackupRow[] }> {
  const backed = await database.select().from(photoBackups);
  const backedIds = new Set(backed.map((row) => row.evidenceId));

  const photos = await database
    .select({
      evidenceId: localEvidence.id,
      localFileUri: localEvidence.localFileUri,
      contentType: localEvidence.contentType,
      checksumSha256: localEvidence.checksumSha256,
      capturedAt: localEvidence.capturedAt,
      syncState: localEvidence.syncState,
      payload: outbox.payload,
    })
    .from(localEvidence)
    .leftJoin(
      outbox,
      and(eq(outbox.entityId, localEvidence.id), eq(outbox.entityType, 'evidence'), eq(outbox.queue, 'media')),
    )
    .where(isNull(localEvidence.deletedAt));

  const write = photos
    .filter((row) => row.localFileUri && !backedIds.has(row.evidenceId))
    .map((row) => ({
      evidenceId: row.evidenceId,
      localFileUri: row.localFileUri!,
      contentType: row.contentType,
      checksumSha256: row.checksumSha256,
      capturedAt: row.capturedAt,
      payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null,
    }));

  const live = new Map(photos.map((row) => [row.evidenceId, row.syncState]));
  const settle = backed.filter((row) => row.sidecarUri !== '' && live.get(row.evidenceId) === 'SYNCED');
  const drop = backed.filter((row) => !live.has(row.evidenceId));

  return { write, settle, drop };
}

export async function recordPhotoBackup(database: LocalDatabase, row: BackupRow): Promise<void> {
  await database.insert(photoBackups).values(row).onConflictDoNothing();
}

/** The photo is on the server: its recovery file is gone, its copy stays. */
export async function settlePhotoBackup(database: LocalDatabase, evidenceId: string): Promise<void> {
  await database.update(photoBackups).set({ sidecarUri: '' }).where(eq(photoBackups.evidenceId, evidenceId));
}

export async function forgetPhotoBackup(database: LocalDatabase, evidenceId: string): Promise<void> {
  await database.delete(photoBackups).where(eq(photoBackups.evidenceId, evidenceId));
}

/** Every copy this store made, so recovery leaves them alone. */
export async function backedUpIds(database: LocalDatabase): Promise<Set<string>> {
  return new Set((await database.select({ id: photoBackups.evidenceId }).from(photoBackups)).map((row) => row.id));
}
