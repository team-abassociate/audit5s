import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import {
  UNIT_COORDINATOR_EDITABLE_FIELDS,
  type Industry,
  type MembershipDetail,
  type Page,
  type Unit,
  type UpdateUnitRequest,
  type User,
} from '@audit5s/contracts';
import { ApiError, api } from '@/lib/api';
import { Link, useParams } from '@tanstack/react-router';
import { Button, Card, CardHeader, EmptyState, ErrorNotice, Field, Input, RowActions, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { useSession } from '@/lib/session';
import { roleLabel } from '@/lib/labels';
import { formatDate } from '@audit5s/domain';

/**
 * Unit master data, plus the Consultant and Coordinator assignments for this Unit.
 *
 * The `name` field is disabled for a Coordinator (invariant U-1) — but that is only the
 * courtesy half. The API enforces it at the field level and answers 403 FIELD_NOT_EDITABLE
 * naming the field, which this form renders inline if it ever arrives.
 */
export function UnitDetail() {
  // `/units/$unitId` (U3): the Unit has its own address, and Back returns to the list.
  const { unitId } = useParams({ strict: false }) as { unitId: string };
  const { scope, can } = useSession();
  const queryClient = useQueryClient();
  const isCoordinator = scope?.role === 'COORDINATOR';

  const unit = useQuery({
    queryKey: ['unit', unitId],
    queryFn: () => api.get<Unit>(`/units/${unitId}`),
  });

  const industries = useQuery({
    queryKey: ['industries', false],
    queryFn: () => api.get<Industry[]>('/industries'),
  });

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const { register, handleSubmit, reset } = useForm<UpdateUnitRequest>({ values: unit.data });

  const update = useMutation({
    mutationFn: (body: UpdateUnitRequest) => api.patch<Unit>(`/units/${unitId}`, body),
    onSuccess: async (updated) => {
      setFieldErrors({});
      reset(updated);
      await queryClient.invalidateQueries({ queryKey: ['unit', unitId] });
      await queryClient.invalidateQueries({ queryKey: ['units'] });
    },
    onError: (error) => {
      setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {});
    },
  });

  if (unit.isLoading) return <Spinner />;
  if (unit.error) return <ErrorNotice error={unit.error} />;
  if (!unit.data) return null;

  const editable = (field: string): boolean =>
    !isCoordinator || (UNIT_COORDINATOR_EDITABLE_FIELDS as readonly string[]).includes(field);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/units" className="gb-btn">
          ← Units & zones
        </Link>
        <h1 className="gb-h1">{unit.data.name}</h1>
      </div>

      <Card>
        <CardHeader
          title="Unit details"
          description={
            isCoordinator
              ? 'You may edit address, contact and timezone. Name and industry are set by a Super Admin.'
              : undefined
          }
        />
        <form
          className="grid gap-3 p-4 sm:grid-cols-2"
          onSubmit={handleSubmit((values) =>
            update.mutate({
              ...values,
              // A `<select>` has no null, only "". The contract wants `null` to mean "no
              // industry", and "" would fail its uuid check with a message about a field
              // the person deliberately left blank.
              industryId: values.industryId ? values.industryId : null,
              version: unit.data!.version,
            }),
          )}
        >
          <Field
            label="Name"
            hint={isCoordinator ? 'Only a Super Admin can change this' : undefined}
            error={fieldErrors.name}
          >
            <Input disabled={!editable('name')} {...register('name')} />
          </Field>

          <Field label="Address" error={fieldErrors.address}>
            <Input {...register('address')} />
          </Field>
          <Field label="City" error={fieldErrors.city}>
            <Input {...register('city')} />
          </Field>
          <Field label="Contact name" error={fieldErrors.contactName}>
            <Input {...register('contactName')} />
          </Field>
          <Field label="Contact phone" hint="With the country code, e.g. +919876543210" error={fieldErrors.contactPhone}>
            <Input {...register('contactPhone')} />
          </Field>
          {/* U4: a choice, not free text. India is the only zone in use; any other the Unit
              already holds stays selectable so saving never changes it silently. */}
          <Field label="Time zone" error={fieldErrors.timezone}>
            <Select {...register('timezone')}>
              <option value="Asia/Kolkata">India (IST)</option>
              {unit.data.timezone !== 'Asia/Kolkata' && (
                <option value={unit.data.timezone}>{unit.data.timezone}</option>
              )}
            </Select>
          </Field>
          {/*
            The sector decides which checklists this plant's audits offer, so it is a Super
            Admin's field like the name (0018) — a Coordinator changing it would silently
            re-point their own auditors at a different catalogue. Blank means no narrowing,
            which is every Unit's behaviour before industries existed.
          */}
          <Field
            label="Industry"
            hint={
              isCoordinator
                ? 'Super Admin only — it decides which checklists this Unit is offered'
                : 'Blank offers every checklist'
            }
            error={fieldErrors.industryId}
          >
            <Select disabled={!editable('industryId')} {...register('industryId')}>
              <option value="">Not set — every checklist</option>
              {(industries.data ?? []).map((industry) => (
                <option key={industry.id} value={industry.id}>
                  {industry.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-2">
            <ErrorNotice error={update.error} />
          </div>

          <div className="sm:col-span-2">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </Card>

      {can('unit_membership', 'read') && <UnitMemberships unitId={unitId} />}
    </div>
  );
}

/** Consultant → Unit assignment and Coordinator assignment, both from PART 6. */
function UnitMemberships({ unitId }: { unitId: string }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState('');

  const memberships = useQuery({
    queryKey: ['memberships', unitId],
    queryFn: () => api.get<Page<MembershipDetail>>(`/memberships?unitId=${unitId}&status=ACTIVE`),
  });

  const assignable = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.get<Page<User>>('/users?limit=200'),
    enabled: can('unit_membership', 'create'),
  });

  const assign = useMutation({
    mutationFn: (id: string) => api.post<MembershipDetail>(`/units/${unitId}/memberships`, { userId: id }),
    onSuccess: async () => {
      setUserId('');
      await queryClient.invalidateQueries({ queryKey: ['memberships'] });
    },
  });

  const revoke = useMutation({
    mutationFn: (membershipId: string) =>
      api.delete<void>(`/units/${unitId}/memberships/${membershipId}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['memberships'] });
    },
  });

  return (
    <Card>
      <CardHeader
        title="People in this Unit"
        description="Its Coordinator and Zone Leaders, and any Consultant given standing access. A Consultant sent here on an audit assignment reaches it through that and is not listed."
      />

      {can('unit_membership', 'create') && (
        <div className="flex items-end gap-2 border-b border-edge-soft bg-board p-4">
          <div className="flex-1">
            <Field
              label="Assign a user to this Unit"
              hint="A Coordinator or Zone Leader can belong to only one Unit at a time."
            >
              <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Select a user…</option>
                {(assignable.data?.data ?? [])
                  .filter((u) => u.role !== 'SUPER_ADMIN')
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName} ({u.loginId}) — {roleLabel(u.role)}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <Button disabled={!userId || assign.isPending} onClick={() => assign.mutate(userId)}>
            Assign
          </Button>
        </div>
      )}

      {assign.error && (
        <div className="p-4">
          <ErrorNotice error={assign.error} />
        </div>
      )}

      {memberships.isLoading && <Spinner />}

      {memberships.data && memberships.data.data.length === 0 && (
        <EmptyState title="No Coordinator or Zone Leader belongs to this Unit yet.">
          Consultants on an audit assignment still reach it through the assignment.
        </EmptyState>
      )}

      {memberships.data && memberships.data.data.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Login ID</Th>
              <Th>Role</Th>
              <Th>Since</Th>
              <Th>{can('unit_membership', 'revoke') ? <span className="sr-only">Actions</span> : null}</Th>
            </tr>
          </thead>
          <tbody>
            {memberships.data.data.map((m) => (
              <tr key={m.id}>
                <Td className="font-medium">{m.userFullName}</Td>
                <Td className="font-mono text-xs">{m.userLoginId}</Td>
                <Td>{roleLabel(m.role)}</Td>
                <Td className="text-xs text-ink-3">
                  {formatDate(m.validFrom)}
                </Td>
                <Td>
                  {can('unit_membership', 'revoke') && (
                    <RowActions
                      subject={m.userFullName}
                      items={[
                        {
                          label: 'Remove from this Unit',
                          danger: true,
                          confirm: {
                            title: `Remove ${m.userFullName} from this Unit?`,
                            body: `They lose access to it straight away${m.role === 'CONSULTANT' ? '' : ', and their open audit assignments here are cancelled'}. What they recorded stays.`,
                            confirmLabel: 'Remove',
                            pendingLabel: 'Removing…',
                            run: () => revoke.mutateAsync(m.id),
                          },
                        },
                      ]}
                    />
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
