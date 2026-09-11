import type { LocalDatabase } from '../db/local-database';
import { SYNC_META_KEYS } from '../db/schema';
import { getSyncMeta } from '../db/catalogue.repository';
import { unsettledItems, unsyncedPhotos } from '../db/outbox.repository';

/**
 * The sync status affordance of §9.9.
 *
 * The section closes with the rule this whole module exists to keep:
 *
 * > The UI must never say "saved" when it means "queued". It says **"Saved on this device"**
 * > and separately **"Synced"** — an honest distinction that prevents the most damaging
 * > field misunderstanding.
 *
 * So `LocalSyncStatus` has two counts and a dot, and no field that could be read as "done".
 */
export type SyncDot = 'synced' | 'pending' | 'syncing' | 'failed';

export interface LocalSyncStatus {
  dot: SyncDot;
  /** Everything not yet acknowledged, split as §9.9 asks. */
  pendingItems: number;
  pendingPhotos: number;
  /** Items that need a person: dead-lettered, with a reason. */
  deadLettered: number;
  syncing: boolean;
  lastSuccessfulPushAt: string | null;
}

export async function readSyncStatus(database: LocalDatabase): Promise<LocalSyncStatus> {
  const rows = await unsettledItems(database);
  const photos = await unsyncedPhotos(database);

  const deadLettered = rows.filter((row) => row.state === 'DEAD_LETTER').length;
  const syncing = rows.some((row) => row.state === 'SYNCING');

  return {
    dot: deadLettered > 0 ? 'failed' : syncing ? 'syncing' : rows.length > 0 ? 'pending' : 'synced',
    pendingItems: rows.length,
    pendingPhotos: photos.length,
    deadLettered,
    syncing,
    lastSuccessfulPushAt: await getSyncMeta(database, SYNC_META_KEYS.lastSuccessfulPushAt),
  };
}

/**
 * §9.7's logout gate.
 *
 * > User taps Logout → count outbox rows where state != 'SYNCED' → 0 clear and wipe;
 * > >0 BLOCK with "You have 14 unsynced items (3 photos) from 2 audits."
 *
 * The sentence it produces is the one §9.7 writes, because the number is the whole point:
 * "you have unsynced work" is ignorable and "14 items, 3 photos, 2 audits" is not.
 *
 * **Force-logout never wipes unsynced data** (§9.7). This function reports; it does not
 * decide, and there is no branch anywhere that turns a blocked logout into a wipe.
 */
export interface LogoutGate {
  blocked: boolean;
  message: string | null;
  pendingItems: number;
  pendingPhotos: number;
  auditCount: number;
}

export async function checkLogoutGate(database: LocalDatabase): Promise<LogoutGate> {
  const status = await readSyncStatus(database);

  const auditCount = new Set(
    (await unsettledItems(database)).map((row) => row.entityId),
  ).size;

  if (status.pendingItems === 0) {
    return { blocked: false, message: null, pendingItems: 0, pendingPhotos: 0, auditCount: 0 };
  }

  const items = `${status.pendingItems} unsynced item${status.pendingItems === 1 ? '' : 's'}`;
  const photos =
    status.pendingPhotos > 0
      ? ` (${status.pendingPhotos} photo${status.pendingPhotos === 1 ? '' : 's'})`
      : '';

  return {
    blocked: true,
    message:
      `You have ${items}${photos} on this device. ` +
      'Sync now, or keep them on this device and log out — nothing will be deleted.',
    pendingItems: status.pendingItems,
    pendingPhotos: status.pendingPhotos,
    auditCount,
  };
}
