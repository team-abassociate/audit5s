import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { PASSWORD_MIN_LENGTH } from '@audit5s/contracts';
import { api } from '@/lib/api';
import { Button, ErrorNotice, Field, Input } from '@/components/ui';
import { useSession } from '@/lib/session';

interface ResetForm {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/**
 * The forced reset (CH-1).
 *
 * The bootstrap credential is the user's own phone number and expires in 72 hours. Until
 * it is rotated every other route answers 403 PASSWORD_RESET_REQUIRED — so this screen is
 * not a suggestion the user can dismiss, and there is deliberately no way past it.
 */
export function ForcedResetPage() {
  const { user, reload, signOut } = useSession();
  const [error, setError] = useState<unknown>(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>();

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post('/auth/change-password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      // Changing the password revokes every other session, so re-read our own.
      await reload();
    } catch (caught) {
      setError(caught);
    }
  });

  return (
    <main className="gb-gate">
      <div className="gb-gate-card gb-gate-card--wide">
        <h1 className="gb-h1">Choose a password</h1>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--ink-2)' }}>
          {user?.fullName}, your account still uses the temporary credential it was created
          with. Set a password of your own before continuing.
        </p>

        <form onSubmit={onSubmit} className="gb-stack" style={{ marginTop: 22 }}>
          <Field label="Current password" hint="The temporary credential you signed in with">
            <Input
              type="password"
              autoComplete="current-password"
              {...register('currentPassword', { required: true })}
            />
          </Field>

          <Field
            label="New password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters, and not your name or phone number`}
            error={errors.newPassword?.message}
          >
            <Input
              type="password"
              autoComplete="new-password"
              {...register('newPassword', {
                required: 'Required',
                minLength: {
                  value: PASSWORD_MIN_LENGTH,
                  message: `At least ${PASSWORD_MIN_LENGTH} characters`,
                },
              })}
            />
          </Field>

          <Field label="Confirm new password" error={errors.confirmPassword?.message}>
            <Input
              type="password"
              autoComplete="new-password"
              {...register('confirmPassword', {
                required: 'Required',
                validate: (value) => value === watch('newPassword') || 'Passwords do not match',
              })}
            />
          </Field>

          <ErrorNotice error={error} />

          {/* Secondary then primary, right-aligned, as every action row in the system. */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button type="button" variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Set password'}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
