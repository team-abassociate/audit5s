import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import type { NotificationPage } from '@audit5s/contracts';
import { api } from '@/lib/api';
import { Link, useRouterState } from '@tanstack/react-router';
import { useSession } from '@/lib/session';

interface NavItem {
  to: string;
  label: string;
  /** The permission that makes this item visible, from the server-resolved scope. */
  resource: string;
  action: string;
  /** Rail section (§5): 1 daily work, 2 setup, 3 records. A rule is drawn between them. */
  group: 1 | 2 | 3;
}

/**
 * Navigation is rendered from the **server-resolved** scope (§8.3): the client never works
 * out what a role may do. Hiding an item is a courtesy, not a control — the API refuses the
 * request regardless.
 */
const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Unit board', resource: 'analytics', action: 'unit_dashboard', group: 1 },
  { to: '/audits', label: 'Audits', resource: 'audit', action: 'read', group: 1 },
  { to: '/corrective-actions', label: 'Corrective actions', resource: 'corrective_action', action: 'read', group: 1 },
  { to: '/notifications', label: 'Notifications', resource: 'notification', action: 'read', group: 1 },
  { to: '/units', label: 'Units & zones', resource: 'unit', action: 'read', group: 2 },
  { to: '/checklists', label: 'Checklists', resource: 'checklist_template', action: 'read', group: 2 },
  // Beside the catalogue it labels. Hidden from anyone who cannot add one — a read-only
  // list of four sector names is not worth a rail entry.
  { to: '/industries', label: 'Industries', resource: 'industry', action: 'create', group: 2 },
  { to: '/users', label: 'Users & roles', resource: 'user', action: 'read', group: 2 },
  { to: '/analytics', label: 'Analytics', resource: 'analytics', action: 'unit_dashboard', group: 3 },
  { to: '/reports', label: 'Reports', resource: 'report', action: 'read_snapshot', group: 3 },
  { to: '/sync', label: 'Sync health', resource: 'sync_conflict', action: 'read', group: 3 },
  { to: '/audit-log', label: 'Activity log', resource: 'audit_log', action: 'read', group: 3 },
];

const TOPBAR_SLOT_ID = 'gb-topbar-tools';

/**
 * The shell of GEMBA-BOARD.md §5: a fixed 216px rail (a horizontal strip below 860px) and
 * a sticky topbar carrying the page title, the page's own scope selectors, the theme
 * switch and the identity chip.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, scope, signOut, can } = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const items = NAV.filter((item) => can(item.resource, item.action));
  const title = items.find((item) => pathname.startsWith(item.to))?.label ?? 'audit5s';

  return (
    <div className="gb-app">
      <aside className="gb-rail">
        <div className="gb-brand">
          <img className="gb-brand-logo" src="/audit5s-logo.png" alt="audit5s" width="42" height="42" />
          <span>audit5s · admin</span>
        </div>
        <nav className="gb-nav">
          {items.map((item, i) => (
            <Fragment key={item.to}>
              {i > 0 && items[i - 1]!.group !== item.group ? <hr /> : null}
              <Link to={item.to} activeProps={{ 'aria-current': 'page' }}>
                {item.label}
                {item.to === '/notifications' ? <UnreadCount /> : null}
              </Link>
            </Fragment>
          ))}
        </nav>
        <div className="gb-railfoot">
          <b>{scope?.organizationWide ? 'Organization-wide' : `${scope?.unitIds.length ?? 0} Unit scope`}</b>
          {scope?.role.replace(/_/g, ' ').toLowerCase()}
        </div>
      </aside>

      <main className="gb-main">
        <div className="gb-top">
          <div className="gb-top-row">
            <h1 className="gb-h1">{title}</h1>
            <div className="gb-shell-tools">
              <ThemeSwitch />
              <div className="gb-who" title={user ? `${user.fullName} · ${user.loginId}` : undefined}>
                <div className="gb-av" aria-hidden="true">{initials(user?.fullName)}</div>
                <div>
                  <b>{user?.fullName}</b>
                  <span>{user?.loginId}</span>
                </div>
              </div>
              <button className="gb-btn" type="button" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </div>
          {/* Pages put their scope selectors here with <TopbarTools> (§5): a second row of
              its own, which collapses to nothing on a page that has none. */}
          <div id={TOPBAR_SLOT_ID} className="gb-tools" />
        </div>
        <div className="gb-page">{children}</div>
      </main>
    </div>
  );
}

/**
 * Renders its children into the topbar. A portal rather than a prop because the selectors
 * belong to the page that owns the queries they filter, and the topbar belongs to the shell.
 */
export function TopbarTools({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(TOPBAR_SLOT_ID)), []);
  return slot ? createPortal(children, slot) : null;
}

/** Two states, remembered per browser (§7). Light — the whiteboard — is the default. */
const MODES = ['light', 'dark'] as const;
const GLYPH = { light: '○', dark: '●' } as const;

function ThemeSwitch() {
  const [mode, setMode] = useState<(typeof MODES)[number]>(() => {
    try {
      const stored = localStorage.getItem('gemba-theme');
      return MODES.find((m) => m === stored) ?? 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', mode);
    try {
      localStorage.setItem('gemba-theme', mode);
    } catch {
      // A browser that refuses storage still gets the theme, just not the memory of it.
    }
  }, [mode]);

  return (
    <button
      className="gb-btn"
      type="button"
      aria-live="polite"
      title={`Theme: ${mode} — click to change`}
      onClick={() => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]!)}
    >
      <span className="gb-data" style={{ marginRight: 6 }}>{GLYPH[mode]}</span>
      {mode[0]!.toUpperCase() + mode.slice(1)}
    </button>
  );
}

/** The unread count, polled: notifications are written by a worker, not by this session. */
function UnreadCount() {
  const unread = useQuery({
    queryKey: ['notifications', 'badge'],
    queryFn: () => api.get<NotificationPage>('/notifications?limit=1&unread=true'),
    refetchInterval: 60_000,
  });
  const count = unread.data?.unreadCount ?? 0;
  return count > 0 ? <i aria-label={`${count} unread`}>{count}</i> : null;
}

function initials(name: string | undefined): string {
  if (!name) return '··';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.at(-1)?.[0] ?? '')).toUpperCase();
}
