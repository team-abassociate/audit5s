import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';

/** How long the panel takes to leave (matches `.gb-sidepanel[data-state='closing']`). */
const PANEL_EXIT_MS = 160;
/** Below this the panel is a full-width sheet over the list (GEMBA §5, detail panels). */
const SHEET_QUERY = '(max-width: 1180px)';
/** Marks a history entry the panel itself pushed, so closing it can go Back instead. */
const PANEL_STATE = '__gbPanel';

/**
 * Open and close a `SidePanel` through the URL (G7, AU1, CA1): `?audit=<id>` opens it, so the
 * detail can be shared, bookmarked and reloaded, and the browser's Back closes it.
 *
 * - `open(id)` pushes an entry the first time and *replaces* it while a panel is already
 *   open, so walking down a list leaves one Back between the reader and the list, not twenty.
 * - `close()` goes Back when the panel pushed the entry being closed, and otherwise (a link
 *   opened straight onto the detail) replaces the URL without the key.
 *
 * The route must keep `key` in its `validateSearch`.
 */
export function useRoutedPanel(key: string): {
  id: string | null;
  open: (id: string) => void;
  close: () => void;
} {
  const router = useRouter();
  const search = useLocation({ select: (location) => location.search as Record<string, unknown> });
  const value = search[key];
  const id = typeof value === 'string' && value !== '' ? value : null;

  const open = (next: string) => {
    void router.navigate({
      to: '.',
      search: ((prev: Record<string, unknown>) => ({ ...prev, [key]: next })) as never,
      state: ((prev: Record<string, unknown>) => ({ ...prev, [PANEL_STATE]: true })) as never,
      replace: id !== null,
      // Opening a detail is not a new page: the list stays where the reader left it.
      resetScroll: false,
    });
  };

  const close = () => {
    const state = router.history.location.state as unknown as Record<string, unknown> | undefined;
    if (state?.[PANEL_STATE]) {
      router.history.back();
      return;
    }
    void router.navigate({
      to: '.',
      search: ((prev: Record<string, unknown>) => {
        const rest = { ...prev };
        delete rest[key];
        return rest;
      }) as never,
      replace: true,
      resetScroll: false,
    });
  };

  return { id, open, close };
}

/**
 * A detail beside its list: an audit, a corrective action, a Unit (GEMBA §6 "Detail panel",
 * generalised from the report preview). Put it as the last child of a `.gb-withpanel`
 * element and the list makes room for it; below 1180px it is a full-width sheet over the list.
 *
 * - **Routed.** Drive `open` from the URL with `useRoutedPanel`, so Back closes it.
 * - **Focus.** On opening — and when another row's detail replaces this one — focus moves to
 *   the heading, so a screen reader starts at the name and the next Tab is inside the panel.
 *   On closing, focus goes back to the control that opened it.
 * - **Keys.** Escape closes it (not while typing in a field, or with a dialog or menu open).
 *   As a sheet, Tab stays inside it: the list underneath cannot be seen.
 * - **Motion.** Slides 16px in from the right with a fade, 220ms; leaves in 160ms. Both are
 *   transitions, so a panel closed mid-entry turns around where it is. Reduced motion fades.
 */
export function SidePanel({
  open,
  title,
  subtitle,
  onClose,
  tools,
  children,
}: {
  open: boolean;
  title: string;
  /** One line under the name: code, leader, when. */
  subtitle?: ReactNode;
  onClose: () => void;
  /** A toolbar row under the header. */
  tools?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);

  // While it leaves, it keeps showing what it showed — not whatever replaced it.
  const shown = useRef({ title, subtitle, tools, children });
  if (open) shown.current = { title, subtitle, tools, children };
  const content = shown.current;

  // Remember who opened it before the heading takes focus; hand focus back on closing.
  useEffect(() => {
    if (!open) return;
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      opener.current = document.activeElement;
    }
    return () => {
      const back = opener.current;
      if (back?.isConnected) back.focus({ preventScroll: true });
      opener.current = null;
    };
  }, [open]);

  // The whole panel comes into view, not just its heading's line, and without a jump when
  // it already is (it is sticky beside the list, so it usually is).
  useEffect(() => {
    if (!open) return;
    heading.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: 'nearest' });
  }, [open, title]);

  useEffect(() => {
    if (open || !present) return;
    const settle = window.setTimeout(() => setPresent(false), PANEL_EXIT_MS);
    return () => window.clearTimeout(settle);
  }, [open, present]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable="true"], dialog, [role="menu"]')
      ) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // As a full-width sheet the list is covered, so focus must not wander under it.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !window.matchMedia(SHEET_QUERY).matches) return;
    const focusable = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.offsetParent !== null);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!present) return null;

  return (
    <aside
      ref={panel}
      className="gb-sidepanel"
      data-state={open ? 'open' : 'closing'}
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
    >
      <header className="gb-sidepanel-head">
        <div className="min-w-0">
          <h2 id={headingId} ref={heading} tabIndex={-1} className="gb-h2">
            {content.title}
          </h2>
          {content.subtitle ? <p>{content.subtitle}</p> : null}
        </div>
        <button
          type="button"
          className="gb-dialog-close"
          onClick={onClose}
          aria-label={`Close ${content.title}`}
          title="Close (Esc)"
        >
          ✕
        </button>
      </header>
      {content.tools ? <div className="gb-sidepanel-tools">{content.tools}</div> : null}
      <div className="gb-sidepanel-body">{content.children}</div>
    </aside>
  );
}
