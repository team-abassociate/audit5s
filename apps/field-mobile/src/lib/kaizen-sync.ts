import type { Kaizen, Page } from '@audit5s/contracts';
import { api } from './api';
import { refreshLocalKaizens } from './db/kaizen.repository';
import type { LocalDatabase } from './db/local-database';

/**
 * Pulls the leader's own Kaizens into SQLite, so their numbers, statuses and the
 * Coordinator's reasons are there offline (and on the module picker). Every page: a
 * Kaizen sent back a year ago is still the leader's to fix.
 */
export async function pullKaizens(database: LocalDatabase): Promise<void> {
  let cursor: string | null = null;
  do {
    const query: string = `/kaizens?mine=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page: Page<Kaizen> = await api.get<Page<Kaizen>>(query);
    await refreshLocalKaizens(database, page.data);
    cursor = page.nextCursor;
  } while (cursor);
}
