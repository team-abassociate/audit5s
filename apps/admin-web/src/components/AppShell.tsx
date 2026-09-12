import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NotificationPage } from '@audit5s/contracts';
import { api } from '@/lib/api';
import { Link, useRouterState } from '@tanstack/react-router';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui';
import { useSession } from '@/lib/session';

interface NavItem {
  to: string;
  label: string;
  /** The permission that makes this item visible, from the server-resolved scope. */
  resource: string;
  action: string;
}

/**
 * Navigation is rendered from the **server-resolved** scope (§8.3): the client never works
 * out what a role may do. Hiding an item is a courtesy, not a control — the API refuses the
 * request regardless.
 */
const NAV: NavItem[] = [
  { to: '/analytics', label: 'Analytics', resource: 'analytics', action: 'unit_dashboard' },
  { to: '/units', label: 'Units', resource: 'unit', action: 'read' },
  { to: '/zones', label: 'Zones', resource: 'zone', action: 'read' },
  { to: '/checklists', label: 'Checklists', resource: 'checklist_template', action: 'read' },
  { to: '/audits', label: 'Audits', resource: 'audit', action: 'read' },
  { to: '/corrective-actions', label: 'Corrective actions', resource: 'corrective_action', action: 'read' },
  { to: '/reports', label: 'Reports', resource: 'report', action: 'read_snapshot' },
  { to: '/sync', label: 'Sync health', resource: 'sync_conflict', action: 'read' },
  { to: '/users', label: 'Users', resource: 'user', action: 'read' },
  { to: '/audit-log', label: 'Audit log', resource: 'audit_log', action: 'read' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, scope, signOut, can } = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="min-h-full">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to="/units" className="text-sm font-semibold text-brand">
              audit5s
            </Link>
            <nav className="flex gap-1">
              {NAV.filter((item) => can(item.resource, item.action)).map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm',
                    pathname.startsWith(item.to)
                      ? 'bg-brand/10 font-medium text-brand'
                      : 'text-neutral-600 hover:bg-neutral-100',
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3 text-sm">
            <NotificationBell />
            <div className="text-right">
              <p className="font-medium text-neutral-800">{user?.fullName}</p>
              <p className="text-xs text-neutral-500">
                {scope?.role.replace(/_/g, ' ').toLowerCase()} · {user?.loginId}
              </p>
            </div>
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

/** The unread count, polled: notifications are written by a worker, not by this session. */
function NotificationBell() {
  const unread = useQuery({
    queryKey: ['notifications', 'badge'],
    queryFn: () => api.get<NotificationPage>('/notifications?limit=1&unread=true'),
    refetchInterval: 60_000,
  });
  const count = unread.data?.unreadCount ?? 0;

  return (
    <Link to="/notifications" className="relative rounded-md px-2 py-1.5 text-neutral-600 hover:bg-neutral-100">
      Notifications
      {count > 0 && (
        <span className="ml-1 rounded-full bg-brand px-1.5 py-0.5 text-xs font-medium text-white">{count}</span>
      )}
    </Link>
  );
}
