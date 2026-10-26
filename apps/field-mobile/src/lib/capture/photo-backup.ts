import * as FileSystem from 'expo-file-system/legacy';
import type { UploadIntentResponse } from '@audit5s/contracts';
import { uuidv7 } from '../db/audit.repository';
import type { LocalDatabase } from '../db/local-database';
import {
  backedUpIds,
  forgetPhotoBackup,
  planPhotoBackup,
  recordPhotoBackup,
  settlePhotoBackup,
} from '../db/photo-backup.repository';
import { TransportError, type SyncTransport } from '../sync/transport';

/**
 * A copy of every audit photo outside the app, in the phone's gallery (R-62).
 *
 * The app's own folder goes with the app: uninstall it, clear its storage or reset the phone,
 * and a photo that never reached the server is gone. So each photo is also written, as a
 * plain JPEG the gallery shows, to a folder the auditor chose through Android's folder
 * picker. That folder outlives the app and needs no storage permission (the manifest still
 * blocks them). The copy is the auditor's to keep (owner, 2026-10-26).
 *
 * While the photo waits to upload, a recovery file sits beside it with its upload request.
 * That file goes once the photo is on the server. After a reinstall, choosing the same folder
 * again sends each photo whose recovery file is still there and belongs to the person signed
 * in. The server already knows most of them (the request is idempotent on the photo's id)
 * and checks the checksum.
 */
const SAF = FileSystem.StorageAccessFramework;
const SETTINGS = `${FileSystem.documentDirectory ?? ''}photo-backup.json`;

interface Sidecar {
  userId: string;
  evidenceId: string;
  photoName: string;
  contentType: string;
  checksumSha256: string;
  payload: Record<string, unknown>;
}

export async function backupFolder(): Promise<string | null> {
  try {
    return (JSON.parse(await FileSystem.readAsStringAsync(SETTINGS)) as { folderUri: string }).folderUri;
  } catch {
    return null;
  }
}

const FOLDER_NAME = 'Audit5S';

/**
 * Android's folder picker, opened on Pictures so the auditor only taps "Use this folder" and
 * "Allow". The app's own `Audit5S` folder inside is found — after a reinstall, the old one —
 * or made. Returns whether a folder was granted.
 */
export async function chooseBackupFolder(): Promise<boolean> {
  const result = await SAF.requestDirectoryPermissionsAsync(SAF.getUriForDirectoryInRoot('Pictures'));
  if (!result.granted) return false;
  const granted = result.directoryUri;
  const folderUri =
    fileName(granted).endsWith(FOLDER_NAME)
      ? granted
      : ((await SAF.readDirectoryAsync(granted)).find((uri) => fileName(uri) === FOLDER_NAME) ??
        (await SAF.makeDirectoryAsync(granted, FOLDER_NAME)));
  await FileSystem.writeAsStringAsync(SETTINGS, JSON.stringify({ folderUri }));
  return true;
}

/** Copies new photos out, and tidies what is no longer needed. Before every sync. */
export async function backUpPhotos(database: LocalDatabase, userId: string): Promise<void> {
  const folder = await backupFolder();
  if (!folder) return;
  const { write, settle, drop } = await planPhotoBackup(database);

  for (const photo of write) {
    // A file already gone from the app (an old install's) has nothing to copy: noted, not retried.
    if (!(await FileSystem.getInfoAsync(photo.localFileUri)).exists) {
      await recordPhotoBackup(database, { evidenceId: photo.evidenceId, photoUri: '', sidecarUri: '' });
      continue;
    }
    const photoName = galleryName(photo.evidenceId, photo.capturedAt);
    // `image/jpeg` is what puts it in the gallery; Android names it `<photoName>.jpg`.
    const photoUri = await SAF.createFileAsync(folder, photoName, 'image/jpeg');
    await FileSystem.writeAsStringAsync(
      photoUri,
      await FileSystem.readAsStringAsync(photo.localFileUri, { encoding: FileSystem.EncodingType.Base64 }),
      { encoding: FileSystem.EncodingType.Base64 },
    );
    let sidecarUri = '';
    if (photo.payload) {
      const sidecar: Sidecar = {
        userId,
        evidenceId: photo.evidenceId,
        photoName: fileName(photoUri),
        contentType: photo.contentType,
        checksumSha256: photo.checksumSha256,
        payload: photo.payload,
      };
      sidecarUri = await SAF.createFileAsync(folder, `${photo.evidenceId}.json`, 'application/json');
      await FileSystem.writeAsStringAsync(sidecarUri, JSON.stringify(sidecar));
    }
    await recordPhotoBackup(database, { evidenceId: photo.evidenceId, photoUri, sidecarUri });
  }

  for (const row of settle) {
    await FileSystem.deleteAsync(row.sidecarUri, { idempotent: true });
    await settlePhotoBackup(database, row.evidenceId);
  }

  for (const row of drop) {
    if (row.photoUri) await FileSystem.deleteAsync(row.photoUri, { idempotent: true });
    if (row.sidecarUri) await FileSystem.deleteAsync(row.sidecarUri, { idempotent: true });
    await forgetPhotoBackup(database, row.evidenceId);
  }
}

/** Recovery files tried this launch that are someone else's or that the server refused. */
const settled = new Set<string>();

/**
 * Sends the photos whose recovery file this store did not make and that belong to `userId`
 * — the photos of a reinstalled app. Returns how many reached the server. One that cannot be
 * attached (its audit never reached the server, or is past R-62's window) keeps its file.
 */
export async function recoverPhotos(
  database: LocalDatabase,
  transport: SyncTransport,
  options: { userId: string; deviceId: string },
): Promise<number> {
  const folder = await backupFolder();
  if (!folder) return 0;
  const ours = await backedUpIds(database);
  const files = new Map((await SAF.readDirectoryAsync(folder)).map((uri) => [fileName(uri), uri]));
  let recovered = 0;

  for (const [name, sidecarUri] of files) {
    if (!name.endsWith('.json')) continue;
    const evidenceId = name.slice(0, -'.json'.length);
    if (ours.has(evidenceId) || settled.has(evidenceId)) continue;

    const sidecar = JSON.parse(await FileSystem.readAsStringAsync(sidecarUri)) as Sidecar;
    const photoUri = files.get(sidecar.photoName);
    if (sidecar.userId !== options.userId || !photoUri) {
      settled.add(evidenceId);
      continue;
    }

    const local = `${FileSystem.cacheDirectory ?? ''}recover-${evidenceId}.jpg`;
    try {
      await FileSystem.copyAsync({ from: photoUri, to: local });
      const intent: UploadIntentResponse = await transport.uploadIntent(sidecar.payload);
      await transport.uploadObject(intent, local, sidecar.contentType);
      const response = await transport.pushBatch({
        batchId: uuidv7(),
        deviceId: options.deviceId,
        clientTime: new Date().toISOString(),
        items: [
          {
            outboxId: uuidv7(),
            entityType: 'evidence',
            entityId: evidenceId,
            operation: 'commit',
            payload: { checksumSha256: sidecar.checksumSha256 },
          },
        ],
      });
      const verdict = response.results[0]?.status;
      if (verdict === 'ACCEPTED' || verdict === 'DUPLICATE') {
        // The photo stays in the gallery; only its recovery file goes.
        await FileSystem.deleteAsync(sidecarUri, { idempotent: true });
        recovered += 1;
      } else {
        settled.add(evidenceId);
      }
    } catch (error) {
      // No signal: try again next cycle. Refused (a 4xx): not again this launch.
      const status = error instanceof TransportError ? error.status : null;
      if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        settled.add(evidenceId);
      }
    } finally {
      await FileSystem.deleteAsync(local, { idempotent: true });
    }
  }
  return recovered;
}

/** `Audit5S_20261026_093012_a1b2c3`: when it was taken, then enough of the id to be unique. */
function galleryName(evidenceId: string, capturedAt: string): string {
  const stamp = capturedAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
  return `Audit5S_${stamp}_${evidenceId.slice(-6)}`;
}

/** `content://…/document/primary%3APictures%2FAudit5S%2F<name>` → `<name>`. */
function fileName(uri: string): string {
  return decodeURIComponent(uri).split('/').pop() ?? '';
}
