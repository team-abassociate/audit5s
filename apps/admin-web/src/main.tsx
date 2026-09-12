import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from '@tanstack/react-router';
import './styles.css';
import { AppShell } from '@/components/AppShell';
import { Spinner } from '@/components/ui';
import { AuditLogPage } from '@/features/audit-log/AuditLogPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { AuditsPage } from '@/features/audits/AuditsPage';
import { CorrectiveActionsPage } from '@/features/corrective-actions/CorrectiveActionsPage';
import { PublicCorrectiveActionPage } from '@/features/corrective-actions/PublicCorrectiveActionPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { SyncHealthPage } from '@/features/sync/SyncHealthPage';
import { ChecklistsPage } from '@/features/checklists/ChecklistsPage';
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

/**
 * The root renders nothing but an outlet, so that **one** route can sit outside the
 * authentication gate: `/ca/$token`.
 *
 * That page is opened by a Zone Leader holding a link from a PDF — somebody who has no
 * session, and who must not be sent to a login screen. Everything else hangs off the
 * pathless `gatedRoute` below and passes through `Gate` exactly as it did before.
 */
const rootRoute = createRootRoute({ component: () => <Outlet /> });

/**
 * The signed corrective-action page (§10.4). No session, no app shell, no navigation to
 * anything else — the link is the whole of the reader's access.
 */
const correctiveActionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ca/$token',
  component: function PublicCorrectiveAction() {
    const { token } = correctiveActionRoute.useParams();
    return <PublicCorrectiveActionPage token={token} />;
  },
});

/** Everything below here is login-gated, which is what `Gate` enforces. */
const gatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'gated',
  component: Gate,
});

/**
 * The landing route. The Zone board is the point of the product, so it is the default —
 * but only for an actor the server has granted the Unit dashboard; anyone else lands on
 * the Units list rather than on a screen whose every query would be refused.
 */
const indexRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/',
  component: function Index() {
    const { can } = useSession();
    return <Navigate to={can('analytics', 'unit_dashboard') ? '/dashboard' : '/units'} replace />;
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/dashboard',
  component: DashboardPage,
});

const unitsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/units',
  component: UnitsPage,
});

const analyticsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/analytics',
  component: AnalyticsPage,
});

const checklistsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/checklists',
  component: ChecklistsPage,
});

const auditsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/audits',
  component: AuditsPage,
});

const correctiveActionsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/corrective-actions',
  component: CorrectiveActionsPage,
});

const reportsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/reports',
  component: ReportsPage,
});

const notificationsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/notifications',
  component: NotificationsPage,
});

const syncRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/sync',
  component: SyncHealthPage,
});

const usersRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/users',
  component: UsersPage,
});

const auditLogRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/audit-log',
  component: AuditLogPage,
});

const routeTree = rootRoute.addChildren([
  // Outside the gate, deliberately and alone.
  correctiveActionRoute,
  gatedRoute.addChildren([
    indexRoute,
    dashboardRoute,
    analyticsRoute,
    unitsRoute,
    checklistsRoute,
    auditsRoute,
    correctiveActionsRoute,
    reportsRoute,
    notificationsRoute,
    syncRoute,
    usersRoute,
    auditLogRoute,
  ]),
]);

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
