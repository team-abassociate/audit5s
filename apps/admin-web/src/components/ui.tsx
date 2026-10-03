import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ComponentProps,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  RefObject,
  SelectHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

export { SidePanel, useRoutedPanel } from './SidePanel';
export { StatusChip, BandLabel, type StatusShape } from './Status';
export { Skeleton } from './Skeleton';
export { EmptyState } from './EmptyState';
export { Slip } from './Slip';

/**
 * The shared controls, built from the Gemba Board primitives
 * (`docs/design/GEMBA-BOARD.md` §6, tokens in `docs/design/gemba-tokens.css`).
 *
 * Every screen composes from this file, so the design system lives here once rather than
 * in fourteen feature folders. No hex literal, no border radius, no blurred shadow — a
 * button is a tile you can press, a card is a magnet, status is a chip.
 */

export function Button({
  className,
  variant = 'primary',
  ...props
}: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return (
    <button
      className={cn(
        'gb-btn',
        variant === 'primary' && 'gb-btn--primary',
        variant === 'danger' && 'gb-btn--danger',
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('gb-input', className)} {...props} />;
}

/**
 * A password field with an eye button, so a person can check what they typed before
 * sending it. Typed hidden by default. `ref` passes through, so react-hook-form's
 * `register` works on it exactly as on `Input`.
 */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="gb-password">
      <input {...props} type={visible ? 'text' : 'password'} className={cn('gb-input', className)} />
      <button
        type="button"
        className="gb-password-toggle"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide password' : 'Show password'}
        onClick={() => setVisible((shown) => !shown)}
      >
        <EyeIcon crossed={visible} />
      </button>
    </span>
  );
}

/** An eye, struck through while the password is showing. Stroked in `currentColor`. */
function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {crossed ? <path d="M3 3l18 18" /> : null}
    </svg>
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('gb-input', className)} {...props} />;
}

/**
 * Type to narrow, or open it and pick — for any list long enough that scrolling it is
 * work: Units, people, templates.
 *
 * The text is the option's `label`; what leaves here is its `id`, or `''` while what has
 * been typed matches nothing — so a caller checks the id, never the text.
 */
export function Combobox({
  value,
  onChange,
  options,
  keepOrder = false,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list'> & {
  value: string;
  onChange: (id: string) => void;
  options: Array<{ id: string; label: string }>;
  /** Keep the caller's order — newest first, say — instead of sorting by label. */
  keepOrder?: boolean;
}) {
  const listId = useId();
  const selectedLabel = options.find((option) => option.id === value)?.label ?? '';
  const [text, setText] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Narrow only on what the person has typed since opening. Filtering on the selected label
  // itself left a picked "AB Associates" offering nothing but "AB Associates".
  const [typing, setTyping] = useState(false);
  const matches = useMemo(() => {
    const query = typing ? text.trim().toLocaleLowerCase() : '';
    const words = query.split(/\s+/).filter(Boolean);
    const found = options.filter((option) => {
      const label = option.label.toLocaleLowerCase();
      return words.every((word) => label.includes(word));
    });
    return keepOrder ? found : found.sort((a, b) => a.label.localeCompare(b.label));
  }, [options, text, typing, keepOrder]);

  // The selection can arrive from outside — a default that lands with its query.
  useEffect(() => setText(selectedLabel), [selectedLabel]);

  const choose = (option: (typeof options)[number]) => {
    setTyping(false);
    setText(option.label);
    onChange(option.id);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive((current) => {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        return Math.max(0, Math.min(matches.length - 1, current + direction));
      });
      return;
    }
    if (event.key === 'Enter' && open && matches[active]) {
      event.preventDefault();
      choose(matches[active]);
    }
  };

  return (
    <div className="gb-combobox">
      <input
        className={cn('gb-input', className)}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={text}
        onFocus={(event) => {
          // Open on the whole list, with the current text selected so typing replaces it.
          setTyping(false);
          setOpen(true);
          event.target.select();
        }}
        onBlur={() => {
          setOpen(false);
          setTyping(false);
          setText(selectedLabel);
        }}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          const typed = event.target.value;
          setText(typed);
          setTyping(true);
          setOpen(true);
          setActive(0);
          const match = options.find(
            (option) => option.label.toLocaleLowerCase() === typed.trim().toLocaleLowerCase(),
          );
          onChange(match?.id ?? '');
        }}
        {...props}
      />
      {open && (
        <ul id={listId} className="gb-combobox-list" role="listbox">
          {matches.map((option, index) => (
            <li
              id={`${listId}-${index}`}
              key={option.id}
              className="gb-combobox-option"
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
            >
              {option.label}
            </li>
          ))}
          {matches.length === 0 && <li className="gb-combobox-empty">No matches</li>}
        </ul>
      )}
    </div>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="gb-field">
      <span className="gb-label">{label}</span>
      {children}
      {hint && !error && <span className="gb-hint">{hint}</span>}
      {error && <span className="gb-field-error">{error}</span>}
    </label>
  );
}

/** A magnet on the board: hard 1.5px edge, hard offset shadow, nothing . */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('gb-panel', className)}>{children}</div>;
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="gb-panel-head">
      <div>
        <h2 className="gb-h2">{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * Tables scroll inside their own container; the page never scrolls sideways (§5).
 *
 * `variant="register"` is for a long list someone works down — Activity log, Users, Industries:
 * fixed column widths, so opening a row or relabelling a button moves nothing (U9, I4, L7),
 * and a header that stays in sight while the rows scroll inside the box. Give it a `label`
 * (the scroll box is a keyboard-reachable region) and give its `Th`s widths; columns without
 * one share what is left.
 */
export function Table({
  children,
  variant = 'flush',
  label,
}: {
  children: ReactNode;
  variant?: 'flush' | 'register';
  label?: string;
}) {
  if (variant === 'register') {
    return (
      <div
        className="gb-tablewrap gb-tablewrap--flush gb-tablewrap--register"
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        <table className="gb-table--register">{children}</table>
      </div>
    );
  }
  return (
    <div className="gb-tablewrap gb-tablewrap--flush">
      <table>{children}</table>
    </div>
  );
}

/** A column head. `width` fixes the column in a register (`'22%'`, `120`). */
export function Th({
  children,
  width,
  className,
}: {
  children?: ReactNode;
  width?: number | string;
  className?: string;
}) {
  return (
    <th scope="col" className={className} style={width === undefined ? undefined : { width }}>
      {children}
    </th>
  );
}

/** `colSpan` so a table can carry group headings without hand-rolling a second cell. */
export function Td({
  children,
  className,
  colSpan,
}: {
  children: ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td className={className} colSpan={colSpan}>
      {children}
    </td>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'gb-chip',
        tone === 'neutral' && 'gb-chip--muted',
        tone === 'good' && 'gb-chip--ok',
        tone === 'warn' && 'gb-chip--warn',
        tone === 'bad' && 'gb-chip--crit',
      )}
    >
      {children}
    </span>
  );
}

/**
 * Renders an API failure: the server's own sentence, plus the field list a
 * FIELD_NOT_EDITABLE carries.
 *
 * The machine code (`INVALID_CREDENTIALS`) is deliberately not shown. The client branches
 * on it (§8.1) and it stays in the problem document and the request log, but on screen it
 * only repeats what the sentence above it already says.
 */
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const problem = error as { message?: string; problem?: { errors?: Array<{ field: string; message: string }> } };
  const fields = problem.problem?.errors ?? [];

  return (
    <div className="gb-notice" role="alert">
      <p style={{ margin: 0 }}>{problem.message ?? 'Something went wrong'}</p>
      {fields.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 12.5 }}>
          {fields.map((f) => (
            <li key={f.field}>
              <b>{f.field}</b>: {f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="gb-label" role="status" style={{ padding: '18px 2px' }}>
      {label}
    </p>
  );
}

/** How long a closing dialog keeps its content while it fades (matches `.gb-dialog` in styles.css). */
const DIALOG_EXIT_MS = 120;

const DialogCloseContext = createContext<(() => void) | null>(null);

/**
 * The close that respects the dialog's unsaved-changes guard. A form's own Cancel button
 * calls this rather than the `onClose` it was given, so Cancel, Escape, ✕ and the scrim
 * all ask the same question before anything typed is thrown away.
 */
export function useDialogClose(): () => void {
  const close = useContext(DialogCloseContext);
  if (!close) throw new Error('useDialogClose() is only available inside a <Dialog>.');
  return close;
}

/**
 * A modal, from the native `<dialog>` (GEMBA-BOARD.md §6 "Dialog"): 2px ink border, 6px hard
 * shadow, label above field, actions right-aligned, secondary then primary. It is
 * `showModal()` and not a div, so the browser traps focus, makes the page behind inert and
 * hands focus back to whatever opened it.
 *
 * - **Closing.** Escape, ✕ and a press on the scrim all go through one request. With `dirty`
 *   set, that request asks first ("Discard changes?") instead of throwing the form away;
 *   a form's own Cancel button gets the same request from `useDialogClose()`.
 * - **Focus.** It lands on `initialFocus` when given — a confirmation puts it on Cancel, so
 *   Enter never destroys anything — and otherwise where the browser puts it.
 * - **Motion.** Fades and scales from 0.98 in 160ms, centred; leaves in 120ms. Both are
 *   transitions, so a dialog closed mid-entry reverses rather than finishing first.
 *
 * Footer actions go in `DialogActions`; body blocks in `.gb-dialog-section`.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  wide = false,
  dirty = false,
  alert = false,
  initialFocus,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  wide?: boolean;
  /** Something typed here is unsaved: closing asks before discarding it. */
  dirty?: boolean;
  /** A confirmation that interrupts (`role="alertdialog"`), not a form. */
  alert?: boolean;
  /** The control that takes focus on open. */
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [guarding, setGuarding] = useState(false);
  // The content stays mounted while the dialog fades out, so it does not empty first.
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);

  const requestClose = useCallback(() => {
    if (dirty) setGuarding(true);
    else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        dialog.showModal();
        initialFocus?.current?.focus();
      }
      return;
    }
    if (dialog.open) dialog.close();
    setGuarding(false);
    const settle = window.setTimeout(() => setPresent(false), DIALOG_EXIT_MS);
    return () => window.clearTimeout(settle);
    // `initialFocus` is read once, at opening; `open` alone drives the element.
  }, [open]);

  return (
    <>
      <dialog
        ref={ref}
        className={cn('gb-dialog', wide && 'gb-dialog--wide')}
        role={alert ? 'alertdialog' : undefined}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onCancel={(event) => {
          event.preventDefault();
          requestClose();
        }}
        // A press on the scrim lands on the dialog element itself, never on its content.
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) requestClose();
        }}
      >
        {present ? (
          <DialogCloseContext.Provider value={requestClose}>
            <div className="gb-dialog-body">
              <header className="gb-dialog-head">
                <div className="min-w-0">
                  <h2 id={titleId} className="gb-h2">
                    {title}
                  </h2>
                  {description ? <p id={descriptionId}>{description}</p> : null}
                </div>
                <button type="button" className="gb-dialog-close" onClick={requestClose} aria-label="Close">
                  ✕
                </button>
              </header>
              {children}
            </div>
          </DialogCloseContext.Provider>
        ) : null}
      </dialog>
      {dirty ? (
        <ConfirmDialog
          open={guarding}
          title="Discard changes?"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          onCancel={() => setGuarding(false)}
          onConfirm={() => {
            setGuarding(false);
            onClose();
          }}
        >
          What you entered in “{title}” has not been saved.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/**
 * A dialog's footer: actions right-aligned, secondary then primary (§6). When the primary
 * is disabled, `reason` says why, on the left of the row — a disabled button with no
 * reason is a dead end. The line is a polite live region, so the reason is announced
 * when it changes.
 */
export function DialogActions({ reason, children }: { reason?: ReactNode; children: ReactNode }) {
  return (
    <div className="gb-dialog-actions">
      <p className="gb-dialog-reason" role="status">
        {reason}
      </p>
      {children}
    </div>
  );
}

/**
 * A question before something that cannot be taken back, named for what it does to what
 * ("Archive Zone 7?"), never "Are you sure?". Cancel holds focus, so Enter is the safe
 * answer. The dialog stays open while `pending`, and shows `error` in place if the action
 * fails, so a failure is read where it was caused.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  pendingLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  pending = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  pending?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!pending) onCancel();
      }}
      title={title}
      alert
      initialFocus={cancel}
    >
      {children ? <div className="gb-dialog-section gb-dialog-text">{children}</div> : null}
      {error ? (
        <div className="gb-dialog-section">
          <ErrorNotice error={error} />
        </div>
      ) : null}
      <DialogActions>
        <Button ref={cancel} variant="secondary" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button variant={tone} onClick={onConfirm} disabled={pending}>
          {pending ? (pendingLabel ?? `${confirmLabel}…`) : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** A destructive row action's question, and the work it confirms. */
export interface RowActionConfirm {
  /** Names the object: "Archive Zone 7?". */
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  /** Resolve to close the dialog; reject to show the error inside it. */
  run: () => Promise<unknown>;
}

/** A safe item runs at once; a destructive one must carry its confirmation. */
export type RowAction =
  | { label: string; onSelect: () => void; disabled?: boolean; hint?: string; danger?: never; confirm?: never }
  | { label: string; danger: true; confirm: RowActionConfirm; disabled?: boolean; hint?: string; onSelect?: never };

/**
 * A row's actions: the one safe, frequent action in sight (`primary`), everything else
 * behind "⋯". Destructive items sit last, under a rule, and never run from the menu: each
 * opens a `ConfirmDialog` naming the object. Nothing destructive is one mis-click away (G6).
 *
 * `subject` names the row for the menu's label ("More actions for Zone 7").
 */
export function RowActions({
  subject,
  primary,
  items,
}: {
  subject: string;
  primary?: ReactNode;
  items: RowAction[];
}) {
  const [confirming, setConfirming] = useState<RowActionConfirm | null>(null);
  // The last question asked stays on screen while its dialog fades out.
  const [shown, setShown] = useState<RowActionConfirm | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const ask = (confirm: RowActionConfirm) => {
    setError(null);
    setShown(confirm);
    setConfirming(confirm);
  };

  const confirm = async () => {
    if (!confirming) return;
    setPending(true);
    setError(null);
    try {
      await confirming.run();
      setConfirming(null);
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  };

  const menu: MenuItem[] = [
    ...items.filter((item) => !item.danger),
    ...items.filter((item) => item.danger),
  ].map((item) => {
    const question = item.confirm;
    return {
      label: item.label,
      disabled: item.disabled,
      hint: item.hint,
      danger: Boolean(item.danger),
      onSelect: question ? () => ask(question) : (item.onSelect ?? (() => undefined)),
    };
  });

  return (
    <div className="gb-rowactions">
      {primary}
      {menu.length > 0 ? <ActionMenu label={`More actions for ${subject}`} items={menu} /> : null}
      {shown ? (
        <ConfirmDialog
          open={confirming !== null}
          title={shown.title}
          confirmLabel={shown.confirmLabel}
          pendingLabel={shown.pendingLabel}
          pending={pending}
          error={error}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void confirm()}
        >
          {shown.body}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

/**
 * A row's secondary actions behind one "⋯" button, so a table of forty reports shows forty
 * Download buttons rather than a hundred and sixty buttons, forty of them red.
 *
 * The list is `position: fixed` at the trigger's corner rather than absolute inside the row:
 * a table scrolls inside its own `overflow-x: auto` container (§5), which would clip it.
 * It scales in from the trigger's corner (origin-aware), closes on Escape, a press outside,
 * a scroll or a choice, and hands focus back to the trigger.
 */
export function ActionMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const menuId = useId();
  const open = at !== null;

  const close = (refocus = true) => {
    setAt(null);
    if (refocus) trigger.current?.focus();
  };

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setAt({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  };

  // A menu near the bottom of the window opens upwards instead of off-screen.
  useLayoutEffect(() => {
    const menu = list.current;
    const rect = trigger.current?.getBoundingClientRect();
    if (!open || !menu || !rect) return;
    if (rect.bottom + 4 + menu.offsetHeight > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, rect.top - 4 - menu.offsetHeight)}px`;
      menu.style.transformOrigin = 'bottom right';
    }
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    // A scroll moves the trigger out from under the list, so the list goes. Not the scroll
    // that focusing the trigger itself queued just before opening; and focus that was in
    // the list goes back to the trigger rather than to <body>.
    const openedAt = performance.now();
    const onScroll = () => {
      if (performance.now() - openedAt < 120) return;
      close(list.current?.contains(document.activeElement) ?? false);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="gb-btn gb-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={() => (open ? close() : show())}
      >
        ⋯
      </button>
      {open ? (
        <ul
          ref={list}
          id={menuId}
          role="menu"
          aria-label={label}
          className="gb-menu"
          style={{ top: at.top, right: at.right }}
          onKeyDown={onKeyDown}
        >
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                className={cn('gb-menu-item', item.danger && 'gb-menu-item--danger')}
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {item.label}
                {/* Why it is unavailable, in sight rather than in a tooltip. */}
                {item.disabled && item.hint ? <span className="gb-menu-hint">{item.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
