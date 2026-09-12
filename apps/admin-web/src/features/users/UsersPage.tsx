import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { ROLES, type CreateUserRequest, type CreateUserResponse, type Page, type Unit, type User } from '@audit5s/contracts';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardHeader, Combobox, ErrorNotice, Field, Input, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { useSession } from '@/lib/session';

export function UsersPage() {
  const { can, scope } = useSession();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<CreateUserResponse | null>(null);

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<Page<User>>('/users?limit=200'),
  });

  return (
    <div className="space-y-4">
      {issued && <BootstrapNotice issued={issued} onDismiss={() => setIssued(null)} />}

      <Card>
        <CardHeader
          title="Users"
          description={
            scope?.role === 'COORDINATOR'
              ? 'Users in your Unit. You may create and manage Zone Leaders.'
              : 'Every user in the organization.'
          }
          action={
            can('user', 'create') ? (
              <Button onClick={() => setCreating((open) => !open)}>
                {creating ? 'Cancel' : 'New user'}
              </Button>
            ) : null
          }
        />

        {creating && (
          <CreateUserForm
            onCreated={(response) => {
              setIssued(response);
              setCreating(false);
            }}
          />
        )}

        {users.isLoading && <Spinner />}
        {users.error && <div className="p-4"><ErrorNotice error={users.error} /></div>}

        {users.data && (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Login ID</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th>Last sign-in</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {users.data.data.map((user) => (
                <UserRow key={user.id} user={user} />
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function UserRow({ user }: { user: User }) {
  const { can, user: self } = useSession();
  const queryClient = useQueryClient();

  const disable = useMutation({
    mutationFn: () => api.post<void>(`/users/${user.id}/disable`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const reset = useMutation({
    mutationFn: () => api.post<{ loginId: string }>(`/users/${user.id}/reset-password`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const statusTone =
    user.status === 'ACTIVE' ? 'good' : user.status === 'DISABLED' ? 'bad' : 'warn';

  return (
    <tr>
      <Td className="font-medium">{user.fullName}</Td>
      <Td className="font-mono text-xs">{user.loginId}</Td>
      <Td>{user.role.replace(/_/g, ' ').toLowerCase()}</Td>
      <Td>
        <div className="flex gap-1">
          <Badge tone={statusTone}>{user.status.toLowerCase()}</Badge>
          {user.mustResetPassword && <Badge tone="warn">reset pending</Badge>}
        </div>
      </Td>
      <Td className="text-xs text-ink-3">
        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'never'}
      </Td>
      <Td>
        <div className="flex gap-2">
          {can('user', 'reset_password') && (
            <Button variant="secondary" disabled={reset.isPending} onClick={() => reset.mutate()}>
              Reset password
            </Button>
          )}
          {can('user', 'disable') && user.status !== 'DISABLED' && user.id !== self?.id && (
            <Button variant="danger" disabled={disable.isPending} onClick={() => disable.mutate()}>
              Disable
            </Button>
          )}
        </div>
      </Td>
    </tr>
  );
}

/**
 * What the create response actually carries: a login ID and an expiry, never a credential.
 * The initial password is the user's own phone number (CH-1) and is never displayed,
 * logged, or sent in plaintext — so this notice tells the administrator what to say, not
 * what to copy.
 */
function BootstrapNotice({ issued, onDismiss }: { issued: CreateUserResponse; onDismiss: () => void }) {
  const expires = new Date(issued.bootstrapExpiresAt);
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 text-sm">
          <p className="font-medium text-ink">
            {issued.user.fullName} can now sign in as{' '}
            <span className="font-mono">{issued.loginId}</span>
          </p>
          <p className="text-ink-2">
            Their temporary password is their own registered phone number. They must change
            it on first sign-in, and it stops working {expires.toLocaleString()}.
          </p>
          <p className="text-xs text-ink-3">
            No password is shown here or sent by message — that is deliberate.
          </p>
        </div>
        <Button variant="secondary" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </Card>
  );
}

function CreateUserForm({ onCreated }: { onCreated: (response: CreateUserResponse) => void }) {
  const { scope } = useSession();
  const queryClient = useQueryClient();
  const isCoordinator = scope?.role === 'COORDINATOR';

  const { register, handleSubmit, reset, control } = useForm<CreateUserRequest>({
    defaultValues: { role: isCoordinator ? 'ZONE_LEADER' : 'CONSULTANT' },
  });

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units'),
    enabled: !isCoordinator,
  });

  const create = useMutation({
    mutationFn: (body: CreateUserRequest) => api.post<CreateUserResponse>('/users', body),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      reset();
      onCreated(response);
    },
  });

  // A Coordinator may create Zone Leaders only, in their own Unit — the server takes the
  // Unit from their membership regardless of what is sent (AZ-2).
  const roles = isCoordinator ? (['ZONE_LEADER'] as const) : ROLES;

  return (
    <form
      className="grid gap-3 border-b border-edge-soft bg-board p-4 sm:grid-cols-2"
      onSubmit={handleSubmit((values) => create.mutate(values))}
    >
      <Field label="Full name" hint="The login ID is derived from this and the phone number">
        <Input placeholder="Rahul Sharma" {...register('fullName', { required: true })} />
      </Field>

      <Field label="Phone" hint="E.164. Also the temporary password, for 72 hours.">
        <Input placeholder="+919876543210" {...register('phone', { required: true })} />
      </Field>

      <Field label="Email (optional)">
        <Input type="email" {...register('email')} />
      </Field>

      <Field label="Role">
        <Select disabled={isCoordinator} {...register('role', { required: true })}>
          {roles.map((role) => (
            <option key={role} value={role}>
              {role.replace(/_/g, ' ').toLowerCase()}
            </option>
          ))}
        </Select>
      </Field>

      {!isCoordinator && (
        <Field label="Unit" hint="Required for every role except Super Admin">
          <Controller
            control={control}
            name="unitId"
            render={({ field }) => (
              <Combobox
                value={field.value ?? ''}
                onChange={field.onChange}
                options={(units.data?.data ?? []).map((unit) => ({ id: unit.id, label: unit.name }))}
                placeholder="Search Units…"
              />
            )}
          />
        </Field>
      )}

      <div className="sm:col-span-2">
        <ErrorNotice error={create.error} />
      </div>

      <div className="sm:col-span-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create user'}
        </Button>
      </div>
    </form>
  );
}
