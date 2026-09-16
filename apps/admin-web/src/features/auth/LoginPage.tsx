import { useState } from 'react';
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
      </div>
    </main>
  );
}
