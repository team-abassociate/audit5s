import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import './styles.css';
import { AppShell } from '@/components/AppShell';
import { Spinner } from '@/components/ui';
import { AuditLogPage } from '@/features/audit-log/AuditLogPage';
import { ForcedResetPage } from '@/features/auth/ForcedResetPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { UnitsPage } from '@/features/units/UnitsPage';
import { UsersPage } from '@/features/users/UsersPage';
import { SessionProvider, useSession } from '@/lib/session';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // A 403 or 404 is an authorization answer, not a transient failure. Retrying one
      // just delays the message the user needs to see.
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status ?? 0;
        return status >= 500 && failureCount < 2;
      },
    },
  },
});

/**
 * The gate every authenticated route passes through.
 *
 * Three states, in order, mirroring the server's own guard chain: not signed in → login;
 * signed in but holding a bootstrap credential → forced reset and nothing else (CH-1);
 * otherwise the application.
 */
function Gate() {
  const { user, loading, mustResetPassword } = useSession();

  if (loading) return <Spinner label="Signing in…" />;
  if (!user) return <LoginPage />;
  if (mustResetPassword) return <ForcedResetPage />;

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

const rootRoute = createRootRoute({ component: Gate });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/units' });
  },
});

const unitsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/units',
  component: UnitsPage,
});

const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users',
  component: UsersPage,
});

const auditLogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit-log',
  component: AuditLogPage,
});

const routeTree = rootRoute.addChildren([indexRoute, unitsRoute, usersRoute, auditLogRoute]);

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
