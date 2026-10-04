import { api, fetchAll } from '@/lib/api';

/**
 * The audits screen's reads. In development, `?data=worst` swaps in the worst-case fixture
 * (`worst-case.ts`: long names, Hindi Zones, an all-N/A section, 1,000 audits) at this
 * boundary, so the screen is stress-tested with its real components. A production build
 * never loads the fixture: the branch is dead code there and the import goes with it.
 */
function worst(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get('data') === 'worst';
}

export async function read<T>(path: string): Promise<T> {
  if (worst()) {
    const fake = (await import('./worst-case')).worstCase(path);
    if (fake !== undefined) return fake as T;
  }
  return api.get<T>(path);
}

export async function readAll<T>(path: string): Promise<T[]> {
  if (worst()) {
    const fake = (await import('./worst-case')).worstCase(path) as { data: T[] } | undefined;
    if (fake) return fake.data;
  }
  return fetchAll<T>(path);
}
