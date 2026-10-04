import { api } from '@/lib/api';

/**
 * Dev-only worst case for Units & zones and Users (UX audit S8, break-ui): open either
 * screen with `?data=worst` and its lists come from `worst-fixtures.ts` instead of the API.
 * Read once at load, so a reload keeps it. A production build drops the branch and never
 * bundles the fixtures. Rows that open further detail (a person's activity) still ask the
 * real API.
 */
const WORST = import.meta.env.DEV && new URLSearchParams(window.location.search).get('data') === 'worst';

export async function devGet<T>(path: string): Promise<T> {
  if (import.meta.env.DEV && WORST) {
    const hit = (await import('./worst-fixtures')).fixture(path);
    if (hit !== undefined) return hit as T;
  }
  return api.get<T>(path);
}
