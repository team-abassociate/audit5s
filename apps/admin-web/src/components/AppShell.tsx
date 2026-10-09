import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import type { NotificationPage } from '@audit5s/contracts';
import { api } from '@/lib/api';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useSession } from '@/lib/session';
import {
  ALL_UNITS,
  rememberScope,
  scopeName,
  useUnitScope,
  validateScopeSearch,
  type ScopeSearch,
  type UnitScope,
} from '@/lib/scope';
import { Combobox, Segmented } from '@/components/ui';
import { roleLabel } from '@/lib/labels';

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
  { to: '/users', label: 'Users', resource: 'user', action: 'read', group: 2 },
  { to: '/analytics', label: 'Analytics', resource: 'analytics', action: 'unit_dashboard', group: 3 },
  { to: '/reports', label: 'Reports', resource: 'report', action: 'read_snapshot', group: 3 },
  { to: '/sync', label: 'Sync health', resource: 'sync_conflict', action: 'read', group: 3 },
  { to: '/audit-log', label: 'Activity log', resource: 'audit_log', action: 'read', group: 3 },
];

/**
 * Kaizen's rail (plans/kaizen-module.md §4.4). The module is the address: anything under
 * `/kaizen` is Kaizen, so a link or a reload lands in the right one with no stored state.
 */
const KAIZEN_NAV: NavItem[] = [
  { to: '/kaizen', label: 'Kaizen overview', resource: 'kaizen', action: 'read', group: 1 },
  { to: '/kaizen/list', label: 'Kaizens', resource: 'kaizen', action: 'read', group: 1 },
  { to: '/kaizen/analysis', label: 'Kaizen analysis', resource: 'kaizen', action: 'read', group: 1 },
];

const TOPBAR_SLOT_ID = 'gb-topbar-tools';
const MAIN_ID = 'gb-main-content';
const PRODUCT = 'audit5s';

/**
 * Sets `document.title` to "{Screen} · {Unit} · audit5s" (UX audit G1): tabs, history and
 * screen readers can tell the pages apart. `undefined` leaves the title alone.
 */
export function useDocumentTitle(...parts: Array<string | undefined>): void {
  const title = parts[0] === undefined ? undefined : [...parts.filter(Boolean), PRODUCT].join(' · ');
  useEffect(() => {
    if (title !== undefined) document.title = title;
  }, [title]);
}

/**
 * The shell of GEMBA-BOARD.md §5: a fixed 216px rail (a horizontal strip below 860px) and
 * a topbar. Only the title row is sticky; the scope row under it scrolls away with the page,
 * so a laptop keeps its height for the board (G15).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, scope, signOut, can } = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const notFound = useRouterState({
    // No screen answered: the router marks the route whose not-found component it renders
    // (`/audits/x` still matches `/audits` as a prefix, so the leaf alone is not enough), or
    // the deepest match is the root or the gate itself.
    select: (s) => {
      const leaf = s.matches.at(-1);
      return (
        s.matches.some((match) => match._notFound || match.status === 'notFound') ||
        !leaf ||
        leaf.routeId === '__root__' ||
        leaf.routeId === '/gated'
      );
    },
  });
  const kaizen = pathname === '/kaizen' || pathname.startsWith('/kaizen/');
  const nav = kaizen ? KAIZEN_NAV : NAV;
  const items = nav.filter((item) => can(item.resource, item.action));
  // The longest match: `/kaizen` is a prefix of every Kaizen screen.
  const match = (list: NavItem[]) =>
    list.filter((item) => pathname.startsWith(item.to)).sort((a, b) => b.to.length - a.to.length)[0];
  const current = notFound ? undefined : match(items);
  // The screen's name comes from the rail even when the rail hides it from this role.
  const screen = notFound ? undefined : match(nav);
  const title = notFound ? 'Page not found' : (screen?.label ?? '');
  // A screen for one record (`/units/$unitId`) names the tab after that record itself.
  const ownTitle = useRouterState({ select: (s) => Object.keys(s.matches.at(-1)?.params ?? {}).length > 0 });
  const unitScope = useUnitScope();
  useDocumentTitle(ownTitle && !notFound ? undefined : title || undefined, scopeName(unitScope));
  useCanonicalScope(unitScope);

  return (
    <div className="gb-app">
      <a className="gb-skip" href={`#${MAIN_ID}`}>
        Skip to content
      </a>
      <div className="gb-rail">
        <div className="gb-brand">
          <img className="gb-brand-logo" src="/audit5s-logo.png" alt="audit5s" width="42" height="42" />
          <span>audit5s · portal</span>
        </div>
        {can('kaizen', 'read') ? <ModuleSwitch kaizen={kaizen} /> : null}
        <Nav items={items} current={current} />
        <div className="gb-railfoot">
          <b>{scope?.organizationWide ? 'Organization-wide' : `${scope?.unitIds.length ?? 0} Unit scope`}</b>
          {roleLabel(scope?.role)}
        </div>
      </div>

      <div className="gb-main">
        <header className="gb-top">
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
        </header>
        {/* The scope row: the portal's Unit (on a screen it filters), then whatever the page
            puts here with <TopbarTools>. It collapses to nothing when both are empty. */}
        <div className="gb-tools">
          <UnitScopePicker scope={unitScope} />
          <div id={TOPBAR_SLOT_ID} className="gb-tools-slot" />
        </div>
        <main id={MAIN_ID} className="gb-page" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

/** 5S | Kaizen (§4.4): the two modules, for a role that holds both. */
function ModuleSwitch({ kaizen }: { kaizen: boolean }) {
  const navigate = useNavigate();
  return (
    <div className="gb-module">
      <Segmented
        label="Module"
        options={[
          { value: '5s', label: '5S' },
          { value: 'kaizen', label: 'Kaizen' },
        ]}
        value={kaizen ? 'kaizen' : '5s'}
        onChange={(module) => void navigate({ to: module === 'kaizen' ? '/kaizen' : '/' })}
      />
    </div>
  );
}

/**
 * The rail's links. Below 860px the rail is a strip: the daily-work group stays in it, the
 * rest move into "More" (G13), and the strip fades at whichever edge has more to scroll to.
 */
function Nav({ items, current }: { items: NavItem[]; current: NavItem | undefined }) {
  const strip = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const measure = () => {
      const { scrollLeft, scrollWidth, clientWidth } = element;
      setEdges({ start: scrollLeft > 1, end: scrollLeft + clientWidth < scrollWidth - 1 });
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [items.length]);

  const fade = [edges.start && 'start', edges.end && 'end'].filter(Boolean).join(' ') || undefined;
  const more = items.filter((item) => item.group !== 1);

  return (
    <>
      <nav ref={strip} className="gb-nav" aria-label="Main" data-fade={fade}>
        {items.map((item, i) => (
          <Fragment key={item.to}>
            {i > 0 && items[i - 1]!.group !== item.group ? <hr /> : null}
            <Link
              to={item.to}
              className={item.group === 1 ? undefined : 'gb-nav-more-item'}
              activeProps={{ 'aria-current': 'page' }}
            >
              {item.label}
              {item.to === '/notifications' ? <UnreadCount /> : null}
            </Link>
          </Fragment>
        ))}
      </nav>
      {more.length > 0 ? <MoreMenu items={more} current={current} /> : null}
    </>
  );
}

/** "More ▾": the setup and records links, on the strip only (CSS hides it on the rail). */
function MoreMenu({ items, current }: { items: NavItem[]; current: NavItem | undefined }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const inside = current && items.includes(current) ? current : undefined;

  // A navigation closes it, whichever way it happened.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="gb-navmore">
      <button
        ref={button}
        type="button"
        className="gb-navmore-btn"
        aria-expanded={open}
        aria-controls={menuId}
        data-current={inside ? '' : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {inside ? inside.label : 'More'} <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul id={menuId} className="gb-navmore-list">
          {items.map((item) => (
            <li key={item.to}>
              <Link to={item.to} activeProps={{ 'aria-current': 'page' }}>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The portal's one Unit picker (G4, B15). Shown only on a screen the Unit filters; a fixed
 * Unit (a Coordinator's) is a label, not a control.
 */
function UnitScopePicker({ scope }: { scope: UnitScope }) {
  if (scope.mode === undefined || (scope.ready && scope.units.length === 0)) return null;

  if (scope.fixed) {
    return (
      <div className="gb-sel gb-scope">
        <span className="gb-label">Unit</span>
        <b className="gb-scope-fixed">{scope.unit?.name}</b>
      </div>
    );
  }

  const options = [
    ...(scope.allowAll ? [{ id: ALL_UNITS, label: scope.allLabel }] : []),
    ...scope.units
      .map((unit) => ({ id: unit.id, label: unit.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];

  return (
    <div className="gb-sel gb-scope">
      <label className="gb-label" htmlFor="gb-scope-unit">
        Unit
      </label>
      <Combobox
        id="gb-scope-unit"
        className="gb-sel-input"
        value={scope.unitId === null ? ALL_UNITS : scope.unitId}
        // Typing reports '' until a name matches; only a real choice moves the scope.
        onChange={(id) => id && scope.setUnit(id)}
        options={options}
        keepOrder
        spellCheck={false}
        placeholder={scope.ready ? 'Search Units…' : 'Loading Units…'}
        disabled={!scope.ready}
      />
    </div>
  );
}

/**
 * Writes the resolved Unit into the URL (replacing, so Back is not polluted), so what is on
 * screen is always what a copied link or a reload shows.
 */
function useCanonicalScope(scope: UnitScope) {
  const navigate = useNavigate();
  const current = useRouterState({
    select: (s) => validateScopeSearch(s.location.search as Record<string, unknown>).unit,
  });
  const { canonical } = scope;
  useEffect(() => {
    if (canonical === undefined) return;
    rememberScope(canonical);
    if (canonical !== current) {
      void navigate({
        to: '.',
        search: ((prev: ScopeSearch) => ({ ...prev, unit: canonical })) as never,
        replace: true,
      });
    }
  }, [canonical, current, navigate]);
}

/** A path nothing answers (E1): inside the shell, saying what was asked for, with a way back. */
export function NotFoundPage() {
  const { can } = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const board = can('analytics', 'unit_dashboard');
  useDocumentTitle('Page not found');
  return (
    <section className="gb-notfound" aria-labelledby="gb-notfound-h">
      <h2 id="gb-notfound-h">This page does not exist</h2>
      <p>
        Nothing is at <code className="gb-data">{pathname}</code>. The link may be mistyped, or what it
        pointed to may have moved.
      </p>
      <Link className="gb-btn gb-btn--primary" to={board ? '/dashboard' : '/units'}>
        {board ? 'Back to Unit board' : 'Back to Units'}
      </Link>
    </section>
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

/**
 * The unread count, polled: notifications are written by a worker, not by this session. The
 * badge is mounted once by the shell, so a route change neither refetches nor restarts it.
 */
function UnreadCount() {
  const unread = useQuery({
    queryKey: ['notifications', 'badge'],
    queryFn: () => api.get<NotificationPage>('/notifications?limit=1&unread=true'),
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
  const count = unread.data?.unreadCount ?? 0;
  return count > 0 ? <i aria-label={`${count} unread`}>{count}</i> : null;
}

function initials(name: string | undefined): string {
  if (!name) return '··';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.at(-1)?.[0] ?? '')).toUpperCase();
}
