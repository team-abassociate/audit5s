import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button, Card, ErrorNotice, Field, Input } from '@/components/ui';
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
    <main className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6">
          <h1 className="text-lg font-semibold text-brand">audit5s</h1>
          <p className="mt-1 text-sm text-neutral-500">5S Audit Management</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
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
            <Input
              type="password"
              autoComplete="current-password"
              {...register('password', { required: true })}
            />
          </Field>

          <ErrorNotice error={error} />

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
