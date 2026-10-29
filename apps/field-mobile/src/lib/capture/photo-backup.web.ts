/**
 * R-62's gallery copy is Android's folder picker (`photo-backup.ts`); a browser has no folder
 * to keep it in, so there is no copy and nothing to recover. Same exports, doing nothing.
 */
export async function backupFolder(): Promise<string | null> {
  return null;
}

export async function chooseBackupFolder(): Promise<boolean> {
  return false;
}

export async function backUpPhotos(): Promise<void> {}

export async function recoverPhotos(): Promise<number> {
  return 0;
}
