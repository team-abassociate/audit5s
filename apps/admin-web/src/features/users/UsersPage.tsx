import { Fragment, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import {
  ROLES,
  type CreateUserRequest,
  type CreateUserResponse,
  type MembershipDetail,
  type Page,
  type Role,
  type Unit,
  type UpdateUserRequest,
  type User,
} from '@audit5s/contracts';
import { ApiError, api } from '@/lib/api';
import { Badge, Button, Card, CardHeader, Combobox, ErrorNotice, Field, Input, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { useSession } from '@/lib/session';

const mobileDigits = (phone: string) => phone.replace(/\D/g, '').slice(-10);

function keepMobileDigits(event: FormEvent<HTMLInputElement>) {
  event.currentTarget.value = event.currentTarget.value.replace(/\D/g, '').slice(0, 10);
}

export function UsersPage() {
  const { can, scope } = useSession();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<CreateUserResponse | null>(null);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<Role | ''>('');

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<Page<User>>('/users?limit=200'),
  });
  const query = search.trim().toLocaleLowerCase();
  const list = (users.data?.data ?? []).filter(
    (user) =>
      (!role || user.role === role) &&
      [user.fullName, user.loginId, user.email, user.phoneE164].some((value) =>
        value?.toLocaleLowerCase().includes(query),
      ),
  );

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

        <div className="grid gap-3 border-b border-edge-soft bg-board p-4 sm:grid-cols-2">
          <Field label="Search users">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, login ID, phone or email…"
            />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(event) => setRole(event.target.value as Role | '')}>
              <option value="">All roles</option>
              <option value="CONSULTANT">Consultants</option>
              <option value="COORDINATOR">Coordinators</option>
              <option value="ZONE_LEADER">Zone Leaders</option>
              <option value="SUPER_ADMIN">Super Admins</option>
            </Select>
          </Field>
        </div>

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
              {list.map((user) => (
                <UserRow key={user.id} user={user} />
              ))}
              {list.length === 0 && (
                <tr>
                  <Td className="text-ink-3">No matching users.</Td>
                </tr>
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function UserRow({ user }: { user: User }) {
  const { can, scope, user: self } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  const revokeAccess = useMutation({
    mutationFn: () => api.post<void>(`/users/${user.id}/disable`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const reset = useMutation({
    mutationFn: () => api.post<{ loginId: string }>(`/users/${user.id}/reset-password`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  /**
   * Removal, as far as D8 allows (R-25): archived and disabled, never deleted. Their audits,
   * photographs and log entries stay exactly as they are — they simply leave every list.
   */
  const remove = useMutation({
    mutationFn: () => api.post<void>(`/users/${user.id}/archive`),
    onSuccess: async () => {
      setConfirmingRemoval(false);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const statusTone =
    user.status === 'ACTIVE' ? 'good' : user.status === 'DISABLED' ? 'bad' : 'warn';
  // A Coordinator manages Zone Leaders and nobody else (§6.3). Offering them a button the
  // server refuses for anyone else is an invitation to a 403.
  const manageable = scope?.role === 'SUPER_ADMIN' || user.role === 'ZONE_LEADER';
  const isSelf = user.id === self?.id;

  return (
    <Fragment>
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
          <div className="flex flex-wrap gap-2">
            {can('user', 'update') && manageable && (
              <Button variant="secondary" onClick={() => setEditing((open) => !open)}>
                {editing ? 'Close' : 'Edit'}
              </Button>
            )}
            {can('user', 'reset_password') && (manageable || isSelf) && (
              <Button
                variant="secondary"
                disabled={reset.isPending}
                onClick={() => reset.mutate()}
              >
                Reset password
              </Button>
            )}
            {can('user', 'disable') && manageable && user.status !== 'DISABLED' && !isSelf && (
              <Button
                variant="danger"
                title="Disable sign-in and revoke every session and device. They stay in this list."
                disabled={revokeAccess.isPending}
                onClick={() => revokeAccess.mutate()}
              >
                Revoke access
              </Button>
            )}
            {can('user', 'archive') && !isSelf && (
              <Button
                variant="danger"
                title="Remove from every list. Their audits, photographs and activity log stay."
                disabled={remove.isPending}
                onClick={() => (confirmingRemoval ? remove.mutate() : setConfirmingRemoval(true))}
              >
                {remove.isPending
                  ? 'Removing…'
                  : confirmingRemoval
                    ? 'Confirm removal'
                    : 'Remove'}
              </Button>
            )}
            {confirmingRemoval && !remove.isPending && (
              <Button variant="secondary" onClick={() => setConfirmingRemoval(false)}>
                Keep
              </Button>
            )}
          </div>
          {confirmingRemoval && (
            <p className="mt-2 text-xs text-ink-2">
              {user.fullName} leaves every list and can no longer sign in. Everything they
              recorded — audits, photographs, the activity log — is kept, because a 5S record
              that could be erased would not be a record.
            </p>
          )}
          {(revokeAccess.error || reset.error || remove.error) && (
            <div className="mt-2">
              <ErrorNotice error={revokeAccess.error ?? reset.error ?? remove.error} />
            </div>
          )}
        </Td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={6} className="bg-board p-0">
            <EditUserForm user={user} onDone={() => setEditing(false)} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function EditUserForm({ user, onDone }: { user: User; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<UpdateUserRequest>({
    defaultValues: {
      fullName: user.fullName,
      phone: mobileDigits(user.phoneE164),
      email: user.email,
    },
  });
  const update = useMutation({
    mutationFn: (body: UpdateUserRequest) => api.patch<User>(`/users/${user.id}`, body),
    onSuccess: async () => {
      setFieldErrors({});
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      onDone();
    },
    onError: (error) => setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {}),
  });

  return (
    <form
      className="grid gap-3 p-4 sm:grid-cols-3"
      onSubmit={handleSubmit((body) => update.mutate(body))}
    >
      <Field label="Full name" error={fieldErrors.fullName}>
        <Input {...register('fullName', { required: true })} />
      </Field>
      <Field
        label="Mobile number"
        hint="Enter exactly 10 digits"
        error={errors.phone?.message ?? fieldErrors.phone}
      >
        <Input
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={10}
          pattern="[0-9]{10}"
          placeholder="9876543210"
          onInput={keepMobileDigits}
          {...register('phone', {
            required: 'Enter a 10-digit mobile number',
            pattern: { value: /^\d{10}$/, message: 'Enter exactly 10 digits' },
          })}
        />
      </Field>
      <Field label="Email" error={fieldErrors.email}>
        <Input type="email" {...register('email')} />
      </Field>
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {update.error && (
        <div className="sm:col-span-3">
          <ErrorNotice error={update.error} />
        </div>
      )}
      <div className="sm:col-span-3">
        <UserUnits user={user} />
      </div>
    </form>
  );
}

/**
 * The Units this person can reach, and the way to change them (§8.4).
 *
 * It sits inside the edit form because that is where an administrator looks for it — but a
 * membership is not a user field: each change is its own call, takes effect at once, and
 * revoking one cancels that Unit's open assignments (AA-1). Every button here says
 * `type="button"`, or it would submit the form around it.
 */
function UserUnits({ user }: { user: User }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [unitId, setUnitId] = useState('');

  const memberships = useQuery({
    queryKey: ['memberships', 'user', user.id],
    queryFn: () =>
      api.get<Page<MembershipDetail>>(`/memberships?userId=${user.id}&status=ACTIVE&limit=200`),
  });
  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
    enabled: can('unit_membership', 'create'),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['memberships'] }),
      queryClient.invalidateQueries({ queryKey: ['users'] }),
    ]);
  const grant = useMutation({
    mutationFn: () => api.post(`/units/${unitId}/memberships`, { userId: user.id }),
    onSuccess: async () => {
      setUnitId('');
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (membership: MembershipDetail) =>
      api.delete(`/units/${membership.unitId}/memberships/${membership.id}`),
    onSuccess: refresh,
  });

  if (user.role === 'SUPER_ADMIN') {
    return <p className="text-xs text-ink-2">A Super Admin reaches every Unit.</p>;
  }

  const held = memberships.data?.data ?? [];
  const heldIds = new Set(held.map((membership) => membership.unitId));
  const addable = (units.data?.data ?? []).filter((unit) => !heldIds.has(unit.id));

  return (
    <div className="border-t border-edge-soft pt-3">
      <span className="gb-label">Units</span>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {held.map((membership) => (
          <span
            key={membership.id}
            className="flex items-center gap-2 border border-edge-soft bg-tile px-2 py-1 text-sm"
          >
            {membership.unitName}
            {can('unit_membership', 'revoke') && (
              <Button
                type="button"
                variant="secondary"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(membership)}
              >
                Remove
              </Button>
            )}
          </span>
        ))}
        {held.length === 0 && (
          <span className="text-xs text-ink-2">
            No Unit yet, so this person can reach nothing.
          </span>
        )}
      </div>

      {can('unit_membership', 'create') && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="w-64">
            <Field label="Add to a Unit">
              <Combobox
                value={unitId}
                onChange={setUnitId}
                options={addable.map((unit) => ({ id: unit.id, label: unit.name }))}
                placeholder="Search Units…"
              />
            </Field>
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={!unitId || grant.isPending}
            onClick={() => grant.mutate()}
          >
            {grant.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      )}

      {(grant.error || revoke.error) && (
        <div className="mt-2">
          <ErrorNotice error={grant.error ?? revoke.error} />
        </div>
      )}
      {user.role !== 'CONSULTANT' && (
        <p className="mt-2 text-xs text-ink-2">
          A {user.role === 'COORDINATOR' ? 'Coordinator' : 'Zone Leader'} belongs to one Unit
          at a time (M-1); adding a second is refused.
        </p>
      )}
    </div>
  );
}

/**
 * What the create response actually carries: a login ID and an expiry, never a credential.
 * The initial password is the user's own phone number (CH-1) and is never displayed,
 * logged, or sent in plaintext — so this notice tells the administrator what to say, not
 * what to copy.
 */
export function BootstrapNotice({
  issued,
  onDismiss,
}: {
  issued: CreateUserResponse;
  onDismiss: () => void;
}) {
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

export function CreateUserForm({
  onCreated,
  fixedRole,
  fixedUnitId,
}: {
  onCreated: (response: CreateUserResponse) => void;
  fixedRole?: Role;
  fixedUnitId?: string;
}) {
  const { scope } = useSession();
  const queryClient = useQueryClient();
  const isCoordinator = scope?.role === 'COORDINATOR';

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors },
  } = useForm<CreateUserRequest>({
    defaultValues: { role: fixedRole ?? (isCoordinator ? 'ZONE_LEADER' : 'CONSULTANT') },
  });

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units'),
    enabled: !isCoordinator && !fixedUnitId,
  });

  const create = useMutation({
    mutationFn: (body: CreateUserRequest) =>
      api.post<CreateUserResponse>('/users', {
        ...body,
        ...(fixedRole ? { role: fixedRole } : {}),
        ...(fixedUnitId ? { unitId: fixedUnitId } : {}),
      }),
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

      <Field
        label="Mobile number"
        hint="10 digits only. Also the temporary password, for 72 hours."
        error={errors.phone?.message}
      >
        <Input
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={10}
          pattern="[0-9]{10}"
          placeholder="9876543210"
          onInput={keepMobileDigits}
          {...register('phone', {
            required: 'Enter a 10-digit mobile number',
            pattern: { value: /^\d{10}$/, message: 'Enter exactly 10 digits' },
          })}
        />
      </Field>

      <Field label="Email (optional)">
        <Input type="email" {...register('email')} />
      </Field>

      {!fixedRole && (
        <Field label="Role">
          <Select disabled={isCoordinator} {...register('role', { required: true })}>
            {roles.map((role) => (
              <option key={role} value={role}>
                {role.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {!isCoordinator && !fixedUnitId && (
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
