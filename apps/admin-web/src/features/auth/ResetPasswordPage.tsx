import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from '@tanstack/react-router';
import type { ResetPasswordRequest } from '@audit5s/contracts';
import { api } from '@/lib/api';
import { Button, ErrorNotice, Field, PasswordInput } from '@/components/ui';

/**
 * The second half of the emailed reset link (§12.1).
 *
 * No session, no app shell — the person here cannot log in, which is why they are here.
 * The token in the URL is the whole of their credential: holding it proves they can read
 * the account's mailbox.
 */
export function ResetPasswordPage({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  const { register, handleSubmit, watch } = useForm<{ newPassword: string; confirm: string }>();

  const reset = useMutation({
    mutationFn: (body: ResetPasswordRequest) => api.post<void>('/auth/reset-password', body),
    onSuccess: () => setDone(true),
  });

  const newPassword = watch('newPassword') ?? '';
  const confirm = watch('confirm') ?? '';
  // Checked here as well as on the server, because the server never sees this field: a
  // mistyped confirmation is the one failure the API cannot tell them about.
  const mismatch = confirm.length > 0 && newPassword !== confirm;

  if (!token) {
    return (
      <Shell title="This link is incomplete">
        <p className="text-sm text-ink-2">
          The address has no reset token in it. Open the link from your email again, or ask for a
          new one.
        </p>
        <Link className="gb-btn gb-btn--block" to="/">
          Back to sign in
        </Link>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell title="Password changed">
        <p className="text-sm text-ink-2">
          You can sign in with your new password. Every other session was signed out, on every
          device.
        </p>
        <Link className="gb-btn gb-btn--primary gb-btn--block" to="/">
          Sign in
        </Link>
      </Shell>
    );
  }

  return (
    <Shell title="Choose a new password">
      <form
        className="space-y-3"
        onSubmit={handleSubmit((values) => {
          if (values.newPassword !== values.confirm) return;
          reset.mutate({ token, newPassword: values.newPassword });
        })}
      >
        <Field label="New password">
          <PasswordInput autoComplete="new-password" {...register('newPassword')} />
        </Field>
        <Field label="Confirm new password" error={mismatch ? 'The two do not match' : undefined}>
          <PasswordInput autoComplete="new-password" {...register('confirm')} />
        </Field>

        <ErrorNotice error={reset.error} />

        <Button
          type="submit"
          variant="primary"
          className="gb-btn--block"
          disabled={reset.isPending || mismatch || newPassword.length === 0}
        >
          {reset.isPending ? 'Saving…' : 'Set password'}
        </Button>
      </form>
      <p className="mt-3 text-xs text-ink-3">
        The link works once. If it has expired, ask for a new one from the sign-in page.
      </p>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="gb-gate">
      <div className="gb-gate-card">
        <h1 className="gb-h1 mb-3">{title}</h1>
        {children}
      </div>
    </div>
  );
}
