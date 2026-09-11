import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Button({
  className,
  variant = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-brand text-white hover:bg-brand/90',
        variant === 'secondary' &&
          'border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-50',
        variant === 'danger' && 'bg-band-needs-support text-white hover:opacity-90',
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm',
        'focus:border-brand focus:ring-1 focus:ring-brand focus:outline-none',
        'disabled:bg-neutral-100 disabled:text-neutral-500',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm',
        'focus:border-brand focus:ring-1 focus:ring-brand focus:outline-none',
        className,
      )}
      {...props}
    />
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
    <label className="block space-y-1">
      <span className="text-sm font-medium text-neutral-700">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-neutral-500">{hint}</span>}
      {error && <span className="block text-xs text-band-needs-support">{error}</span>}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-neutral-200 bg-white shadow-sm', className)}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between border-b border-neutral-200 px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-neutral-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}

export function Th({ children }: { children: ReactNode }) {
  return (
    <th className="border-b border-neutral-200 px-4 py-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
      {children}
    </th>
  );
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn('border-b border-neutral-100 px-4 py-2', className)}>{children}</td>;
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'bg-neutral-100 text-neutral-700',
        tone === 'good' && 'bg-band-outstanding/10 text-band-outstanding',
        tone === 'warn' && 'bg-band-improving/10 text-band-improving',
        tone === 'bad' && 'bg-band-needs-support/10 text-band-needs-support',
      )}
    >
      {children}
    </span>
  );
}

/** Renders an API failure, including the field list a FIELD_NOT_EDITABLE carries. */
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const problem = error as { message?: string; code?: string; problem?: { errors?: Array<{ field: string; message: string }> } };
  const fields = problem.problem?.errors ?? [];

  return (
    <div className="rounded-md border border-band-needs-support/30 bg-band-needs-support/5 px-3 py-2 text-sm text-band-needs-support">
      <p>{problem.message ?? 'Something went wrong'}</p>
      {fields.length > 0 && (
        <ul className="mt-1 list-inside list-disc text-xs">
          {fields.map((f) => (
            <li key={f.field}>
              <span className="font-medium">{f.field}</span>: {f.message}
            </li>
          ))}
        </ul>
      )}
      {problem.code && <p className="mt-1 font-mono text-xs opacity-70">{problem.code}</p>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <p className="px-4 py-6 text-sm text-neutral-500">{label}</p>;
}
