import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useForm } from 'react-hook-form';
import { Button, ErrorNotice, Field, Input, PasswordInput } from '@/components/ui';
import { useSession } from '@/lib/session';

interface LoginForm {
  loginId: string;
  password: string;
}

export function LoginPage() {
  const { signIn } = useSession();
  const [error, setError] = useState<unknown>(null);
  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<LoginForm>();

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await signIn({ loginId: values.loginId.toUpperCase(), password: values.password });
    } catch (caught) {
      setError(caught);
    }
  });

  return (
    <main className="gb-gate">
      {/* One tile on the dry-erase ground: the same magnet the board is built from. */}
      <div className="gb-gate-card">
        <div className="gb-gate-brand" style={{ marginBottom: 22 }}>
          <b>audit5s</b>
          <span>5S Audit Management</span>
        </div>

        <form onSubmit={onSubmit} className="gb-stack">
          <Field label="Login ID" hint="Issued when your account was created, e.g. RA3210">
            <Input
              autoFocus
              autoComplete="username"
              placeholder="RA3210"
              className="uppercase"
              {...register('loginId', { required: true })}
            />
          </Field>

          <Field label="Password">
            <PasswordInput
              autoComplete="current-password"
              {...register('password', { required: true })}
            />
          </Field>

          <ErrorNotice error={error} />

          <Button type="submit" className="gb-btn--block" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <ForgotPassword />
      </div>
    </main>
  );
}

/**
 * Asks for the emailed reset link (§12.1).
 *
 * The answer is the same sentence whether or not the login ID exists, and whether or not
 * that account has an address on file. Anything else here is a login-ID oracle: a form
 * that says "no such user" tells an attacker which names to keep.
 */
function ForgotPassword() {
  const [open, setOpen] = useState(false);
  const [loginId, setLoginId] = useState('');
  const [sent, setSent] = useState(false);

  const request = useMutation({
    mutationFn: (id: string) => api.post<void>('/auth/forgot-password', { loginId: id }),
    // Settled, not success: a failure here would otherwise reveal, by its absence, that
    // the previous case was the one that worked.
    onSettled: () => setSent(true),
  });

  if (sent) {
    return (
      <p className="mt-4 border-t border-edge-soft pt-3 text-sm text-ink-2">
        If that login ID has an email address on file, a reset link is on its way. It works once
        and expires within the hour.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="mt-4 border-t border-edge-soft pt-3 text-sm text-ink-2 underline"
        onClick={() => setOpen(true)}
      >
        Forgot your password?
      </button>
    );
  }

  return (
    <form
      className="mt-4 space-y-2 border-t border-edge-soft pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (loginId.trim()) request.mutate(loginId.trim());
      }}
    >
      <Field label="Your login ID" hint="We will email the address on your account.">
        <Input
          value={loginId}
          onChange={(event) => setLoginId(event.target.value)}
          autoComplete="username"
        />
      </Field>
      <Button
        type="submit"
        variant="secondary"
        className="gb-btn--block"
        disabled={request.isPending || loginId.trim().length === 0}
      >
        {request.isPending ? 'Sending…' : 'Email me a reset link'}
      </Button>
    </form>
  );
}
