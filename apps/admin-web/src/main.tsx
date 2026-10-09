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
  retainSearchParams,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import './styles.css';
import { AppShell, NotFoundPage, useDocumentTitle } from '@/components/AppShell';
import { componentsRoute } from '@/components/dev/route';
import { Spinner } from '@/components/ui';
import { AuditLogPage, validateAuditLogSearch } from '@/features/audit-log/AuditLogPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { AuditsPage, isStatusFilter, type AuditsSearch } from '@/features/audits/AuditsPage';
import {
  CorrectiveActionsPage,
  validateCorrectiveActionsSearch,
} from '@/features/corrective-actions/CorrectiveActionsPage';
import { PublicCorrectiveActionPage } from '@/features/corrective-actions/PublicCorrectiveActionPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import {
  KaizenAnalysisPage,
  KaizenOverviewPage,
  KaizensPage,
  validateKaizensSearch,
} from '@/features/kaizen/KaizenPages';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { SyncHealthPage, validateSyncSearch } from '@/features/sync/SyncHealthPage';
import { IndustriesPage } from '@/features/industries/IndustriesPage';
import { ChecklistsPage } from '@/features/checklists/ChecklistsPage';
import { ForcedResetPage } from '@/features/auth/ForcedResetPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage';
import { UnitsPage } from '@/features/units/UnitsPage';
import { UnitDetail } from '@/features/units/UnitDetail';
import { UsersPage, type UsersSearch } from '@/features/users/UsersPage';
import { SessionProvider, useSession } from '@/lib/session';
import { validateScopeSearch, type ScopeSearch } from '@/lib/scope';

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
function Gate({ children }: { children?: ReactNode }) {
  const { user, loading, mustResetPassword } = useSession();
  useDocumentTitle(loading || user ? undefined : 'Sign in');

  if (loading) return <Spinner label="Signing in…" />;
  if (!user) return <LoginPage />;
  if (mustResetPassword) return <ForcedResetPage />;

  return <AppShell>{children ?? <Outlet />}</AppShell>;
}

/**
 * The root renders nothing but an outlet, so that **one** route can sit outside the
 * authentication gate: `/ca/$token`.
 *
 * That page is opened by a Zone Leader holding a link from a PDF — somebody who has no
 * session, and who must not be sent to a login screen. Everything else hangs off the
 * pathless `gatedRoute` below and passes through `Gate` exactly as it did before.
 */
const rootRoute = createRootRoute({
  component: () => <Outlet />,
  // A path nothing matches (`/nope`, `/audits/does-not-exist`) still gets the shell, behind
  // the same gate, with a way back (UX audit E1) — never a bare "Not Found".
  notFoundComponent: () => (
    <Gate>
      <NotFoundPage />
    </Gate>
  ),
});

/**
 * The signed corrective-action page (§10.4). No session, no app shell, no navigation to
 * anything else — the link is the whole of the reader's access.
 */
const correctiveActionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ca/$token',
  component: function PublicCorrectiveAction() {
    const { token } = correctiveActionRoute.useParams();
    useDocumentTitle('Corrective action');
    return <PublicCorrectiveActionPage token={token} />;
  },
});

/**
 * The emailed password-reset link (§12.1). Public for the same reason the corrective-action
 * page is: the person opening it cannot sign in, which is the entire reason they are here.
 *
 * The token rides in the query string rather than the path so it stays out of the route
 * pattern, and so an empty one renders a readable message instead of a 404.
 */
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
  component: function ResetPassword() {
    const { token } = resetPasswordRoute.useSearch();
    useDocumentTitle('Reset password');
    return <ResetPasswordPage token={token} />;
  },
});

/**
 * Everything below here is login-gated, which is what `Gate` enforces.
 *
 * It also owns the portal's Unit scope, `?unit=` (`lib/scope.ts`): validated once here and
 * carried onto every navigation, so a link that names only its own route keeps the Unit.
 */
const gatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'gated',
  validateSearch: (search: Record<string, unknown>): ScopeSearch => validateScopeSearch(search),
  search: { middlewares: [retainSearchParams<ScopeSearch>(['unit'])] },
  component: () => <Gate />,
  notFoundComponent: NotFoundPage,
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
  staticData: { unitScope: 'one' },
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
  staticData: { unitScope: 'one' },
  component: AnalyticsPage,
});

const industriesRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/industries',
  component: IndustriesPage,
});

const checklistsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/checklists',
  component: ChecklistsPage,
});

const auditsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/audits',
  staticData: { unitScope: 'any' },
  // A notification lands on the exact audit or assignment it is about, not just the tab.
  validateSearch: (search: Record<string, unknown>): AuditsSearch => ({
    audit: typeof search.audit === 'string' ? search.audit : undefined,
    assignment: typeof search.assignment === 'string' ? search.assignment : undefined,
    status: isStatusFilter(search.status) ? search.status : undefined,
  }),
  component: AuditsPage,
});

/** AU1: an audit's own address opens it in the register's side panel. */
const auditRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/audits/$auditId',
  component: function AuditLink() {
    const { auditId } = auditRoute.useParams();
    return <Navigate to="/audits" search={{ audit: auditId }} replace />;
  },
});

const correctiveActionsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/corrective-actions',
  staticData: { unitScope: 'any' },
  // CA1, CA5: the open item (`?action=`), the filters, the sort and the grouping live in the URL.
  validateSearch: validateCorrectiveActionsSearch,
  component: CorrectiveActionsPage,
});

/** CA1: an action's own address opens it in the list's side panel. */
const correctiveActionDetailRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/corrective-actions/$actionId',
  component: function CorrectiveActionLink() {
    const { actionId } = correctiveActionDetailRoute.useParams();
    return <Navigate to="/corrective-actions" search={{ action: actionId }} replace />;
  },
});

/**
 * R-39: a Coordinator holds no report permission, so a typed or bookmarked `/reports` goes
 * home instead of opening a page whose every query the server refuses. The rail already
 * hides the link; this is the same courtesy for the address bar.
 */
const reportsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/reports',
  staticData: { unitScope: 'any' },
  component: function Reports() {
    const { can } = useSession();
    return can('report', 'read_snapshot') ? <ReportsPage /> : <Navigate to="/" replace />;
  },
});

const notificationsRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/notifications',
  component: NotificationsPage,
});

const syncRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/sync',
  staticData: { unitScope: 'any' },
  // The held queue's filters live in the URL; a "field work held" notification opens it
  // filtered to the phone it came from (N3).
  validateSearch: validateSyncSearch,
  component: SyncHealthPage,
});

const usersRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/users',
  validateSearch: (search: Record<string, unknown>): UsersSearch => ({
    user: typeof search.user === 'string' ? search.user : undefined,
  }),
  component: UsersPage,
});

const auditLogRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/audit-log',
  staticData: { unitScope: 'any' },
  validateSearch: validateAuditLogSearch,
  component: AuditLogPage,
});

/**
 * Kaizen (plans/kaizen-module.md §4.4): its own corner of the portal under `/kaizen`, which
 * is also what puts the shell's module switch on Kaizen. A role without `kaizen:read` is
 * sent home rather than shown pages whose every query the server refuses.
 */
function KaizenOnly({ children }: { children: ReactNode }) {
  const { can } = useSession();
  return can('kaizen', 'read') ? children : <Navigate to="/" replace />;
}

const kaizenOverviewRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/kaizen',
  staticData: { unitScope: 'any' },
  component: () => (
    <KaizenOnly>
      <KaizenOverviewPage />
    </KaizenOnly>
  ),
});

const kaizenListRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/kaizen/list',
  staticData: { unitScope: 'any' },
  // The open Kaizen (`?kaizen=`) and the status filter live in the URL, as corrective actions'.
  validateSearch: validateKaizensSearch,
  component: () => (
    <KaizenOnly>
      <KaizensPage />
    </KaizenOnly>
  ),
});

const kaizenAnalysisRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/kaizen/analysis',
  staticData: { unitScope: 'any' },
  component: () => (
    <KaizenOnly>
      <KaizenAnalysisPage />
    </KaizenOnly>
  ),
});

/** A Kaizen's own address opens it in the list's side panel. */
const kaizenDetailRoute = createRoute({
  getParentRoute: () => gatedRoute,
  path: '/kaizen/$kaizenId',
  component: function KaizenLink() {
    const { kaizenId } = kaizenDetailRoute.useParams();
    return <Navigate to="/kaizen/list" search={{ kaizen: kaizenId }} replace />;
  },
});

const routeTree = rootRoute.addChildren([
  // Outside the gate, deliberately and alone.
  correctiveActionRoute,
  resetPasswordRoute,
  ...(import.meta.env.DEV ? [componentsRoute(rootRoute)] : []), // the component gallery (UX audit S4)
  gatedRoute.addChildren([
    indexRoute,
    dashboardRoute,
    analyticsRoute,
    unitsRoute,
    createRoute({ getParentRoute: () => gatedRoute, path: '/units/$unitId', component: UnitDetail }), // U3
    industriesRoute,
    checklistsRoute,
    auditsRoute,
    auditRoute,
    correctiveActionsRoute,
    correctiveActionDetailRoute,
    reportsRoute,
    notificationsRoute,
    syncRoute,
    usersRoute,
    auditLogRoute,
    kaizenOverviewRoute,
    kaizenListRoute,
    kaizenAnalysisRoute,
    kaizenDetailRoute,
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
