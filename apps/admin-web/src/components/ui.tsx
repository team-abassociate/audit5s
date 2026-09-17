import { useEffect, useId, useMemo, useState } from 'react';
import type {
  ButtonHTMLAttributes,
  ComponentProps,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

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
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
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
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list'> & {
  value: string;
  onChange: (id: string) => void;
  options: Array<{ id: string; label: string }>;
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
    return options
      .filter((option) => option.label.toLocaleLowerCase().includes(query))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [options, text]);

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

/** Tables scroll inside their own container; the page never scrolls sideways (§5). */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="gb-tablewrap gb-tablewrap--flush">
      <table>{children}</table>
    </div>
  );
}

export function Th({ children }: { children: ReactNode }) {
  return <th>{children}</th>;
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
  return <p className="gb-label" style={{ padding: '18px 2px' }}>{label}</p>;
}
