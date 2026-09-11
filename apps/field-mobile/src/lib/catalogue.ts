import type { SyncCatalogue } from '@audit5s/contracts';
import { api } from './api';
import {
  getSyncMeta,
  replaceCatalogue,
} from './db/catalogue.repository';
import type { LocalDatabase } from './db/local-database';
import { SYNC_META_KEYS } from './db/schema';

export interface CatalogueSyncResult {
  changed: boolean;
  catalogueVersion: string;
  syncedAt: string;
}

/**
 * Pulls `GET /sync/catalogue` and replaces the device's cached reference data.
 *
 * The device sends the `catalogueVersion` it holds, so an unchanged catalogue costs one
 * small response and no writes — which is the normal case, and the one that matters on a
 * connection shared with a plant's machinery.
 *
 * A failure is not an error state for the app: the cache is still valid, and every screen
 * reads from SQLite rather than from this call. That is the whole point of §9.1.
 */
export async function syncCatalogue(database: LocalDatabase): Promise<CatalogueSyncResult> {
  const since = await getSyncMeta(database, SYNC_META_KEYS.catalogueVersion);
  const query = since ? `?since=${encodeURIComponent(since)}` : '';
  const catalogue = await api.get<SyncCatalogue>(`/sync/catalogue${query}`);

  await replaceCatalogue(database, catalogue);

  return {
    changed: catalogue.catalogueVersion !== since,
    catalogueVersion: catalogue.catalogueVersion,
    syncedAt: new Date().toISOString(),
  };
}

/** What the Profile tab shows: when the cache was last refreshed, if ever. */
export async function lastCatalogueSyncAt(database: LocalDatabase): Promise<string | null> {
  return getSyncMeta(database, SYNC_META_KEYS.lastCatalogueSyncAt);
}
