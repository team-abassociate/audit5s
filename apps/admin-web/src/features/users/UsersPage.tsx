import { Fragment, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import {
  type Audit,
  type AuditAssignment,
  type AuditStatus,
  type CreateUserRequest,
  type CreateUserResponse,
  type MembershipDetail,
  type Page,
  type Role,
  type Unit,
  type UpdateUserRequest,
  type User,
  type Zone,
} from '@audit5s/contracts';
import { ApiError, api } from '@/lib/api';
import { devGet } from '@/features/units/worst-case';
import {
  Button,
  Card,
  CardHeader,
  Combobox,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  RowActions,
  Select,
  Skeleton,
  Spinner,
  StatusChip,
  Table,
  Td,
  Th,
  type RowAction,
} from '@/components/ui';
import { useSession } from '@/lib/session';
import { bandTextClass } from '@/lib/bands';
import { cn } from '@/lib/cn';
import { Link, useSearch } from '@tanstack/react-router';
import { RowToggle, rowToggleProps } from '@/features/audits/AuditsPage';
import { AUDIT_STATUS_LABEL, AUDIT_TYPE_LABEL, ROLE_LABEL, roleLabel } from '@/lib/labels';
import { formatDate, formatDateTime, formatScore } from '@audit5s/domain';

/** Least privileged first, so a slip of the hand never lands on Super Admin (US3). */
const ROLES_BY_REACH: readonly Role[] = ['ZONE_LEADER', 'CONSULTANT', 'COORDINATOR', 'SUPER_ADMIN'];

const mobileDigits = (phone: string) => phone.replace(/\D/g, '').slice(-10);

/*
 * US1: below 54rem of its own width (1024 beside the sidebar) the register drops Last
 * sign-in to under the status, so Edit and ⋯ stay in sight instead of scrolling out of the
 * box. The table's minimum drops with it (an unlayered rule, hence `!`).
 */
const TABLE_MIN = '[&_table]:min-w-[720px]!';
const HIDE_SIGN_IN = '@max-[54rem]:hidden';
const SHOW_SIGN_IN = '@min-[54rem]:hidden';

function keepMobileDigits(event: FormEvent<HTMLInputElement>) {
  event.currentTarget.value = event.currentTarget.value.replace(/\D/g, '').slice(0, 10);
}

/** `/users?user=…` — opens that person's row. */
export interface UsersSearch {
  user?: string;
}

export function UsersPage() {
  const { can, scope } = useSession();
  const linked = useSearch({ strict: false }) as UsersSearch;
  const [expanded, setExpanded] = useState<string | null>(linked.user ?? null);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<CreateUserResponse | null>(null);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<Role | ''>('');

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => devGet<Page<User>>('/users?limit=200'),
  });
  // US2: which plant each person runs or works in — their memberships, and for a Consultant
  // (who holds none, R-28) the Units of their open assignments. One page of each, like the list.
  const memberships = useQuery({
    queryKey: ['memberships', 'all'],
    queryFn: () => devGet<Page<MembershipDetail>>('/memberships?status=ACTIVE&limit=200'),
    enabled: can('unit_membership', 'read'),
  });
  const assignments = useQuery({
    queryKey: ['audit-assignments', 'open', 'all'],
    queryFn: () => devGet<Page<AuditAssignment>>('/audit-assignments?open=true&limit=200'),
    enabled: can('audit_assignment', 'read'),
  });
  const unitsOf = new Map<string, Set<string>>();
  for (const [userId, unitName] of [
    ...(memberships.data?.data ?? []).map((m) => [m.userId, m.unitName] as const),
    ...(assignments.data?.data ?? []).map((a) => [a.auditorUserId, a.unitName] as const),
  ]) {
    unitsOf.set(userId, (unitsOf.get(userId) ?? new Set<string>()).add(unitName));
  }

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
              {ROLES_BY_REACH.map((value) => (
                <option key={value} value={value}>
                  {ROLE_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {users.isLoading && (
          <Skeleton
            variant="rows"
            columns={['Name', 'Login ID', 'Role', 'Units', 'Status', 'Last sign-in', '']}
            label="Loading users…"
          />
        )}
        {users.error && <div className="p-4"><ErrorNotice error={users.error} /></div>}

        {users.data && list.length === 0 && (
          <EmptyState title="No matching users.">Try another name, or All roles.</EmptyState>
        )}

        {users.data && list.length > 0 && (
          <div className={cn('@container', TABLE_MIN)}>
          <Table variant="register" label="Users">
            <thead>
              <tr>
                <Th width="19%">Name</Th>
                <Th width="10%">Login ID</Th>
                <Th width="11%">Role</Th>
                <Th width="17%">Units</Th>
                <Th width="13%">Status</Th>
                <Th width="16%" className={HIDE_SIGN_IN}>Last sign-in</Th>
                <Th width="14%"><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {list.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  units={user.role === 'SUPER_ADMIN' ? null : [...(unitsOf.get(user.id) ?? [])]}
                  open={expanded === user.id}
                  onToggle={() => setExpanded(expanded === user.id ? null : user.id)}
                />
              ))}
            </tbody>
          </Table>
          </div>
        )}
      </Card>
    </div>
  );
}

function UserRow({
  user,
  units,
  open,
  onToggle,
}: {
  user: User;
  /** `null` for a Super Admin, who reaches every Unit. */
  units: string[] | null;
  open: boolean;
  onToggle: () => void;
}) {
  const { can, scope, user: self } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const signedIn = user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never';
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const revokeAccess = useMutation({
    mutationFn: () => api.post<void>(`/users/${user.id}/disable`),
    onSuccess: refresh,
  });

  /** Undoes "Revoke access"; the person signs in again on each phone. */
  const restoreAccess = useMutation({
    mutationFn: () => api.post<void>(`/users/${user.id}/enable`),
    onSuccess: refresh,
  });

  const reset = useMutation({
    mutationFn: () => api.post<{ loginId: string }>(`/users/${user.id}/reset-password`),
    onSuccess: refresh,
  });

  /**
   * Archiving, as far as D8 allows (R-25): archived and disabled, never deleted. Their audits,
   * photographs and log entries stay exactly as they are — they simply leave every list.
   */
  const archive = useMutation({
    mutationFn: () => api.post<void>(`/users/${user.id}/archive`),
    onSuccess: refresh,
  });

  // A Coordinator manages Zone Leaders and nobody else (§6.3). Offering them an action the
  // server refuses for anyone else is an invitation to a 403.
  const manageable = scope?.role === 'SUPER_ADMIN' || user.role === 'ZONE_LEADER';
  const isSelf = user.id === self?.id;
  const toggleRow = rowToggleProps(onToggle);

  const items: RowAction[] = [];
  if (can('user', 'reset_password') && (manageable || isSelf)) {
    items.push({ label: 'Reset password', disabled: reset.isPending, onSelect: () => reset.mutate() });
  }
  if (can('user', 'disable') && manageable && !isSelf) {
    items.push(
      user.status === 'DISABLED'
        ? {
            label: 'Restore access',
            disabled: restoreAccess.isPending,
            onSelect: () => restoreAccess.mutate(),
          }
        : {
            label: 'Revoke access',
            danger: true,
            confirm: {
              title: `Revoke ${user.fullName}’s access?`,
              body: `${user.fullName} is signed out of every phone and cannot sign in until access is restored. They stay in this list. Work still on their phone stays there and syncs once they are back.`,
              confirmLabel: 'Revoke access',
              pendingLabel: 'Revoking…',
              run: () => revokeAccess.mutateAsync(),
            },
          },
    );
  }
  if (can('user', 'archive') && !isSelf) {
    items.push({
      label: 'Archive',
      danger: true,
      confirm: {
        title: `Archive ${user.fullName}?`,
        body: `${user.fullName} leaves every list and can no longer sign in. Everything they recorded (audits, photographs, the activity log) is kept, because a 5S record that could be erased would not be a record.`,
        confirmLabel: 'Archive',
        pendingLabel: 'Archiving…',
        run: () => archive.mutateAsync(),
      },
    });
  }

  return (
    <Fragment>
      <tr {...toggleRow} className={cn(toggleRow.className, open && 'gb-row--open')}>
        <Td className="font-medium">
          <RowToggle open={open} onClick={onToggle}>
            {user.fullName}
          </RowToggle>
        </Td>
        <Td className="font-mono text-xs">{user.loginId}</Td>
        <Td>{ROLE_LABEL[user.role]}</Td>
        <Td>
          {units === null ? (
            <span className="text-ink-3">Every Unit</span>
          ) : units.length ? (
            // A Consultant may hold many assignments: name three, count the rest (their row lists all).
            <span title={units.join(', ')}>
              {units.slice(0, 3).join(', ')}
              {units.length > 3 && <span className="text-ink-3"> +{units.length - 3} more</span>}
            </span>
          ) : (
            <span className="text-ink-3">None</span>
          )}
        </Td>
        <Td>
          <StatusChip kind="user" status={user.status} />
          {user.mustResetPassword && <div className="mt-1 text-xs text-ink-3">Must set a password</div>}
          <div className={cn('mt-1 text-xs text-ink-3', SHOW_SIGN_IN)}>Signed in: {signedIn}</div>
        </Td>
        <Td className={cn('text-xs text-ink-3', HIDE_SIGN_IN)}>{signedIn}</Td>
        <Td>
          <RowActions
            subject={user.fullName}
            primary={
              can('user', 'update') && manageable ? (
                <Button
                  variant="secondary"
                  aria-expanded={editing}
                  onClick={() => setEditing((open) => !open)}
                >
                  {editing ? 'Close' : 'Edit'}
                </Button>
              ) : null
            }
            items={items}
          />
          {(restoreAccess.error || reset.error) && (
            <div className="mt-2">
              <ErrorNotice error={restoreAccess.error ?? reset.error} />
            </div>
          )}
        </Td>
      </tr>
      {open && (
        <tr className="gb-row-expand">
          <td colSpan={7}>
            <UserActivity user={user} />
          </td>
        </tr>
      )}
      {editing && (
        <tr>
          <td colSpan={7} className="bg-board p-0">
            <EditUserForm user={user} onDone={() => setEditing(false)} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

const NOT_STARTED: ReadonlySet<AuditStatus> = new Set(['ASSIGNED', 'READY']);
const RUNNING: ReadonlySet<AuditStatus> = new Set(['IN_PROGRESS', 'PAUSED']);

/**
 * What a person is responsible for: the Units they belong to, the assignments waiting on
 * them, and the audits they have running and have finished. Every list is the server's
 * scope-filtered answer, so a Coordinator opening a row sees only their own Unit's share.
 */
function UserActivity({ user }: { user: User }) {
  const conducts = user.role === 'CONSULTANT' || user.role === 'ZONE_LEADER';

  const memberships = useQuery({
    queryKey: ['memberships', 'user', user.id],
    queryFn: () =>
      api.get<Page<MembershipDetail>>(`/memberships?userId=${user.id}&status=ACTIVE&limit=200`),
  });
  const assignments = useQuery({
    queryKey: ['audit-assignments', 'auditor', user.id],
    queryFn: () =>
      api.get<Page<AuditAssignment>>(`/audit-assignments?auditorUserId=${user.id}&open=true&limit=200`),
    enabled: conducts,
  });
  const audits = useQuery({
    queryKey: ['audits', 'auditor', user.id],
    queryFn: () => api.get<Page<Audit>>(`/audits?auditorId=${user.id}&limit=200`),
    enabled: conducts,
  });

  // A Consultant's Units are their open assignments' Units (R-28): they hold no membership.
  const units = [
    ...new Map(
      [
        ...(memberships.data?.data ?? []).map((m) => [m.unitId, { name: m.unitName, via: roleLabel(m.role) }] as const),
        ...(assignments.data?.data ?? []).map((a) => [a.unitId, { name: a.unitName, via: 'assignment' }] as const),
      ],
    ).values(),
  ];
  const all = [...(audits.data?.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // US6: each bucket by its own status, so "In progress" never lists an audit that says
  // Assigned. An unstarted audit whose assignment is already listed is not listed twice.
  const waiting = (assignments.data?.data ?? []).filter((a) => a.status !== 'IN_PROGRESS');
  const waitingIds = new Set(waiting.map((a) => a.id));
  const notStarted = all.filter(
    (audit) => NOT_STARTED.has(audit.status) && !(audit.assignmentId && waitingIds.has(audit.assignmentId)),
  );
  const running = all.filter((audit) => RUNNING.has(audit.status));
  const conducted = all.filter((audit) => audit.completedAt !== null);

  const error = memberships.error ?? assignments.error ?? audits.error;
  if (memberships.isLoading || assignments.isLoading || audits.isLoading) return <Spinner />;

  return (
    <div className="gb-activity">
      {error ? <ErrorNotice error={error} /> : null}
      <section>
        <h3 className="gb-label">Units · {units.length}</h3>
        {units.length === 0 ? (
          <p className="text-ink-3">No Unit at the moment.</p>
        ) : (
          <ul>
            {units.map((unit) => (
              <li key={unit.name}>
                {unit.name} <span className="text-ink-3">· {unit.via}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {conducts && (
        <>
          <section>
            <h3 className="gb-label">Assigned, not started · {waiting.length + notStarted.length}</h3>
            {waiting.length > 0 || notStarted.length === 0 ? <AssignmentList assignments={waiting} /> : null}
            {notStarted.length > 0 && <AuditList audits={notStarted} empty="" />}
          </section>
          <section>
            <h3 className="gb-label">In progress · {running.length}</h3>
            <AuditList audits={running} empty="Nothing running." />
          </section>
          <section>
            <h3 className="gb-label">Conducted · {conducted.length}</h3>
            <AuditList audits={conducted} empty="No finished audit yet." />
          </section>
        </>
      )}
    </div>
  );
}

function AssignmentList({ assignments }: { assignments: AuditAssignment[] }) {
  if (assignments.length === 0) return <p className="text-ink-3">None waiting.</p>;
  return (
    <ul>
      {assignments.map((assignment) => (
        <li key={assignment.id}>
          <Link to="/audits" search={{ assignment: assignment.id }}>
            {assignment.unitName}
          </Link>
          <span className="text-ink-3">
            {' '}· {AUDIT_TYPE_LABEL[assignment.auditType]}
            {assignment.dueAt ? ` · due ${formatDate(assignment.dueAt)}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AuditList({ audits, empty }: { audits: Audit[]; empty: string }) {
  if (audits.length === 0) return <p className="text-ink-3">{empty}</p>;
  return (
    <ul>
      {audits.slice(0, 12).map((audit) => (
        <li key={audit.id}>
          <Link to="/audits" search={{ audit: audit.id }}>
            {audit.unitName}
          </Link>
          <span className="text-ink-3">
            {' '}· {AUDIT_STATUS_LABEL[audit.status]} ·{' '}
            {formatDate(audit.completedAt ?? audit.startedAt ?? audit.createdAt)}
          </span>
          {audit.scored && audit.totals.scorePercentage !== null && audit.completedAt ? (
            <span className={cn('gb-data ml-2', bandTextClass(audit.totals.scorePercentage))}>
              {formatScore(audit.totals.scorePercentage)}%
            </span>
          ) : null}
        </li>
      ))}
      {audits.length > 12 && <li className="text-ink-3">…and {audits.length - 12} earlier</li>}
    </ul>
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
          at a time; adding a second is refused.
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
            it on first sign-in, and it stops working {formatDateTime(expires)}.
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
  forNewZone = false,
}: {
  onCreated: (response: CreateUserResponse) => void;
  fixedRole?: Role;
  fixedUnitId?: string;
  /** The leader is being made for a Zone not created yet, which will point at them. */
  forNewZone?: boolean;
}) {
  const { scope } = useSession();
  const queryClient = useQueryClient();
  const isCoordinator = scope?.role === 'COORDINATOR';

  const {
    register,
    handleSubmit,
    reset,
    control,
    watch,
    formState: { errors },
  } = useForm<CreateUserRequest>({
    defaultValues: { role: fixedRole ?? (isCoordinator ? 'ZONE_LEADER' : 'CONSULTANT') },
    shouldUnregister: true,
  });
  const selectedRole = fixedRole ?? watch('role');
  const requiresUnit = selectedRole === 'COORDINATOR' || selectedRole === 'ZONE_LEADER';
  // R-39: a Zone Leader is created with the Zone they lead — required of a Coordinator,
  // optional for a Super Admin, whose Units may not have Zones yet (R-19).
  const leaderUnitId = fixedUnitId ?? (isCoordinator ? scope?.unitIds[0] : watch('unitId'));
  const picksZone = selectedRole === 'ZONE_LEADER' && !forNewZone && Boolean(leaderUnitId);
  const zones = useQuery({
    queryKey: ['zones', leaderUnitId, 'active'],
    queryFn: () => api.get<Page<Zone>>(`/units/${leaderUnitId}/zones?active=true&limit=200`),
    enabled: picksZone,
  });

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units'),
    enabled: !isCoordinator && !fixedUnitId,
  });

  const create = useMutation({
    mutationFn: (body: CreateUserRequest) => {
      const { unitId: selectedUnitId, zoneId, ...person } = body;
      return api.post<CreateUserResponse>('/users', {
        ...person,
        ...(picksZone && zoneId ? { zoneId } : {}),
        ...(fixedRole ? { role: fixedRole } : {}),
        ...(fixedUnitId
          ? { unitId: fixedUnitId }
          : requiresUnit && selectedUnitId
            ? { unitId: selectedUnitId }
            : {}),
      });
    },
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      reset();
      onCreated(response);
    },
  });

  // A Coordinator may create Zone Leaders only, in their own Unit — the server takes the
  // Unit from their membership regardless of what is sent (AZ-2).
  const roles = isCoordinator ? (['ZONE_LEADER'] as const) : ROLES_BY_REACH;
  // US3: making someone a Super Admin is asked about by name before it is done.
  const [elevating, setElevating] = useState<CreateUserRequest | null>(null);

  return (
    <>
      {/* Outside the form: its buttons would otherwise submit it. */}
      <ConfirmDialog
        open={elevating !== null}
        title={`Make ${elevating?.fullName ?? 'this person'} a Super Admin?`}
        tone="primary"
        confirmLabel="Create Super Admin"
        pendingLabel="Creating…"
        pending={create.isPending}
        error={create.error}
        onCancel={() => setElevating(null)}
        onConfirm={() => {
          if (elevating) create.mutate(elevating, { onSuccess: () => setElevating(null) });
        }}
      >
        A Super Admin sees and changes everything in every Unit, including other people’s
        accounts. Choose a narrower role unless they run the whole organization.
      </ConfirmDialog>
      <form
        className="grid gap-3 border-b border-edge-soft bg-board p-4 sm:grid-cols-2"
        onSubmit={handleSubmit((values) =>
          (fixedRole ?? values.role) === 'SUPER_ADMIN' ? setElevating(values) : create.mutate(values),
        )}
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
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {!isCoordinator && !fixedUnitId && requiresUnit && (
          <Field label="Unit" hint="Required for Coordinators and Zone Leaders" error={errors.unitId?.message}>
            <Controller
              control={control}
              name="unitId"
              rules={{ required: 'Choose a Unit' }}
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

        {picksZone && (
          <Field
            label={isCoordinator ? 'Leads Zone' : 'Leads Zone (optional)'}
            hint={
              zones.data && zones.data.data.length === 0
                ? 'This Unit has no Zones yet. Create the Zone first, and make its leader there.'
                : 'Their Zone. They may still audit, and fix the findings of, every Zone of the Unit.'
            }
            error={errors.zoneId?.message}
          >
            <Select
              {...register('zoneId', { required: isCoordinator ? 'Choose the Zone they lead' : false })}
            >
              <option value="">{isCoordinator ? 'Choose a Zone' : 'No Zone yet'}</option>
              {(zones.data?.data ?? []).map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {`Zone ${zone.code} — ${zone.name}`}
                  {zone.zoneLeaderName ? ` (now ${zone.zoneLeaderName})` : ''}
                </option>
              ))}
            </Select>
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
    </>
  );
}
