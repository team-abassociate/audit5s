import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import type { AnyRoute } from '@tanstack/react-router';

/**
 * `/__components`: every shared component in every state, for building and checking them
 * (UX audit S4). Development only — `main.tsx` adds it behind `import.meta.env.DEV`, so a
 * production build drops it, and the gallery itself is a lazy chunk even in development.
 *
 * It sits outside the sign-in gate on purpose: nothing on it calls the API, and a keyboard
 * or screen-reader pass should not need an account.
 */
export function componentsRoute<TParent extends AnyRoute>(parent: TParent) {
  return createRoute({
    getParentRoute: () => parent,
    path: '/__components',
    validateSearch: (search: Record<string, unknown>): { panel?: string } => ({
      panel: typeof search.panel === 'string' ? search.panel : undefined,
    }),
    component: lazyRouteComponent(() => import('./ComponentGallery'), 'ComponentGallery'),
  });
}
