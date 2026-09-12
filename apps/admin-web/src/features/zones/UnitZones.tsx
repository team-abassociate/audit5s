import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type {
  ChecklistTemplate,
  CreateZoneRequest,
  CreateUserResponse,
  Page,
  User,
  Zone,
} from '@audit5s/contracts';
import { ZONE_NUMBER_MAX, ZONE_NUMBER_MIN } from '@audit5s/contracts';
import { zoneCodeChoices, zoneCodeForNumber, zoneDisplayLabel } from '@audit5s/domain';
import { ApiError, api } from '@/lib/api';
import {
  Badge,
  Button,
  ErrorNotice,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { useSession } from '@/lib/session';
import { BootstrapNotice, CreateUserForm } from '@/features/users/UsersPage';

/**
 * A Unit's Zones, cascaded open under its row on Units & zones.
 *
 * There is no Unit picker and no client-side filter: the list is whatever
 * `GET /units/{id}/zones` returns for the Unit whose row is open, scope-filtered by the
 * server. A Coordinator has exactly one Unit (invariant M-1), so they only ever see one.
 */
export function UnitZones({ unitId }: { unitId: string }) {
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');

  const zones = useQuery({
    queryKey: ['zones', unitId],
    queryFn: () => api.get<Page<Zone>>(`/units/${unitId}/zones?active=false&limit=200`),
  });

  const query = search.trim().toLocaleLowerCase();
  const list = [...(zones.data?.data ?? [])]
    .filter((zone) =>
      [zoneDisplayLabel(zone.code, zone.name), zone.description, zone.zoneLeaderName].some(
        (value) => value?.toLocaleLowerCase().includes(query),
      ),
    )
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));

  return (
    <div className="border-t border-edge-soft bg-board">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <span className="gb-label">
          Zones{zones.data ? ` · ${list.length}` : ''}
        </span>
        <div className="flex flex-1 items-center justify-end gap-2">
          <Input
            type="search"
            className="max-w-xs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Zones…"
            aria-label="Search Zones"
          />
          {can('zone', 'create') && (
            <Button variant="secondary" onClick={() => setCreating((open) => !open)}>
              {creating ? 'Cancel' : 'New Zone'}
            </Button>
          )}
        </div>
      </div>

      {creating && (
        <CreateZoneForm
          unitId={unitId}
          existing={zones.data?.data ?? []}
          onCreated={() => setCreating(false)}
        />
      )}

      {zones.isLoading && <Spinner />}
      {zones.error && (
        <div className="p-4">
          <ErrorNotice error={zones.error} />
        </div>
      )}

      {zones.data && list.length === 0 && (
        <p className="px-4 pb-4 text-sm text-ink-3">
          {query ? 'No matching Zones.' : 'No Zones in this Unit yet. '}
          {!query && (can('zone', 'create')
            ? 'Create the first one — auditors choose from these when they start an audit.'
            : 'A Coordinator creates them.')}
        </p>
      )}

      {list.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Zone</Th>
              <Th>Description</Th>
              <Th>Zone Leader</Th>
              <Th>Default checklist</Th>
              <Th>Status</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((zone) => (
              <ZoneRow key={zone.id} zone={zone} unitId={unitId} />
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function ZoneRow({ zone, unitId }: { zone: Zone; unitId: string }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const archive = useMutation({
    mutationFn: () => api.post(`/zones/${zone.id}/archive`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['zones', unitId] }),
  });

  const templates = useQuery({
    queryKey: ['checklist-templates'],
    queryFn: () => api.get<Page<ChecklistTemplate>>('/checklist-templates?limit=200'),
  });
  const template = templates.data?.data.find(
    (candidate) => candidate.id === zone.defaultChecklistTemplateId,
  );

  return (
    <>
      <tr className={zone.archivedAt ? 'opacity-60' : undefined}>
        <Td>
          <span className="font-medium">{zoneDisplayLabel(zone.code, zone.name)}</span>
        </Td>
        <Td className="max-w-xs truncate text-ink-2">{zone.description ?? '—'}</Td>
        <Td>{zone.zoneLeaderName ?? <span className="text-ink-3">Unassigned</span>}</Td>
        <Td>{template?.name ?? '—'}</Td>
        <Td>
          {zone.archivedAt ? <Badge tone="neutral">Archived</Badge> : <Badge tone="good">Active</Badge>}
        </Td>
        <Td>
          <div className="flex gap-2">
            {can('zone', 'update') && !zone.archivedAt && (
              <Button variant="secondary" onClick={() => setEditing((open) => !open)}>
                {editing ? 'Close' : 'Edit'}
              </Button>
            )}
            {can('zone', 'archive') && !zone.archivedAt && (
              <Button
                variant="danger"
                disabled={archive.isPending}
                onClick={() => archive.mutate()}
              >
                Archive
              </Button>
            )}
          </div>
          {archive.error && (
            <div className="mt-2">
              <ErrorNotice error={archive.error} />
            </div>
          )}
        </Td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={6} className="bg-board p-0">
            <EditZoneForm zone={zone} unitId={unitId} onDone={() => setEditing(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The Zone number is entered as digits and converted to the canonical stored code.
 *
 * The stored `code` remains `Z-01`…`Z-100`, generated by `packages/domain` so the web, the
 * device and the reports spell it the same way.
 */
function CreateZoneForm({
  unitId,
  existing,
  onCreated,
}: {
  unitId: string;
  existing: Zone[];
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [creatingLeader, setCreatingLeader] = useState(false);
  const [issuedLeader, setIssuedLeader] = useState<CreateUserResponse | null>(null);
  const taken = new Set(existing.map((zone) => zone.code));

  const templates = useQuery({
    queryKey: ['checklist-templates'],
    queryFn: () => api.get<Page<ChecklistTemplate>>('/checklist-templates?limit=200'),
  });

  const leaders = useQuery({
    queryKey: ['users', 'zone-leaders', unitId],
    queryFn: () => api.get<Page<User>>(`/users?role=ZONE_LEADER&unitId=${unitId}&limit=200`),
  });

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<Omit<CreateZoneRequest, 'code'> & { zoneNumber: string }>({
    defaultValues: { zoneNumber: String(firstFreeNumber(taken)) },
  });

  const create = useMutation({
    mutationFn: ({
      zoneNumber,
      ...body
    }: Omit<CreateZoneRequest, 'code'> & { zoneNumber: string }) =>
      api.post<Zone>(`/units/${unitId}/zones`, {
        ...body,
        code: zoneCodeForNumber(Number(zoneNumber)),
        sortOrder: Number(zoneNumber),
        defaultChecklistTemplateId: body.defaultChecklistTemplateId || undefined,
        zoneLeaderId: body.zoneLeaderId || undefined,
      }),
    onSuccess: async () => {
      setFieldErrors({});
      reset({ zoneNumber: '' });
      await queryClient.invalidateQueries({ queryKey: ['zones', unitId] });
      onCreated();
    },
    onError: (error) => setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {}),
  });

  const number = register('zoneNumber', {
    required: 'Enter a Zone number',
    validate: (value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < ZONE_NUMBER_MIN || parsed > ZONE_NUMBER_MAX) {
        return `Enter a number from ${ZONE_NUMBER_MIN} to ${ZONE_NUMBER_MAX}`;
      }
      return !taken.has(zoneCodeForNumber(parsed)) || 'That Zone number is already used';
    },
  });

  return (
    <>
      <form
        className="grid gap-3 border-b border-edge-soft bg-board p-4 sm:grid-cols-2"
        onSubmit={handleSubmit((body) => create.mutate(body))}
      >
      <Field
        label="Zone number"
        error={errors.zoneNumber?.message ?? fieldErrors.code}
        hint={`Enter ${ZONE_NUMBER_MIN} to ${ZONE_NUMBER_MAX}`}
      >
        <div className="flex items-center gap-2">
          <span>Zone:</span>
          <Input
            {...number}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={3}
            className="max-w-20 gb-data"
            onChange={(event) => {
              event.target.value = event.target.value.replace(/\D/g, '').slice(0, 3);
              void number.onChange(event);
            }}
          />
        </div>
      </Field>

      <Field label="Name" error={fieldErrors.name}>
        <Input {...register('name')} placeholder="Press shop" />
      </Field>

      <Field
        label="Description"
        error={fieldErrors.description}
        hint="Optional. Shown to the auditor when they pick this Zone."
      >
        <Input {...register('description')} placeholder="Trimming section" />
      </Field>

      <Field label="Zone Leader" error={fieldErrors.zoneLeaderId} hint="Optional. A responsibility, not an access grant.">
        <div className="flex items-center gap-2">
          <Select {...register('zoneLeaderId')}>
            <option value="">Unassigned</option>
            {(leaders.data?.data ?? []).map((leader) => (
              <option key={leader.id} value={leader.id}>
                {leader.fullName} ({leader.loginId})
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setCreatingLeader((open) => !open)}
          >
            {creatingLeader ? 'Cancel' : 'New leader'}
          </Button>
        </div>
      </Field>

      <Field label="Default checklist" error={fieldErrors.defaultChecklistTemplateId}>
        <Select {...register('defaultChecklistTemplateId')}>
          <option value="">None</option>
          {(templates.data?.data ?? []).map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="flex items-end gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create Zone'}
        </Button>
      </div>

      {create.error && (
        <div className="sm:col-span-2">
          <ErrorNotice error={create.error} />
        </div>
      )}
      </form>
      {creatingLeader && (
        <CreateUserForm
          fixedRole="ZONE_LEADER"
          fixedUnitId={unitId}
          onCreated={(response) => {
            setValue('zoneLeaderId', response.user.id);
            setIssuedLeader(response);
            setCreatingLeader(false);
          }}
        />
      )}
      {issuedLeader && (
        <BootstrapNotice issued={issuedLeader} onDismiss={() => setIssuedLeader(null)} />
      )}
    </>
  );
}

function EditZoneForm({
  zone,
  unitId,
  onDone,
}: {
  zone: Zone;
  unitId: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const templates = useQuery({
    queryKey: ['checklist-templates'],
    queryFn: () => api.get<Page<ChecklistTemplate>>('/checklist-templates?limit=200'),
  });
  const leaders = useQuery({
    queryKey: ['users', 'zone-leaders', unitId],
    queryFn: () => api.get<Page<User>>(`/users?role=ZONE_LEADER&unitId=${unitId}&limit=200`),
  });

  const { register, handleSubmit } = useForm({
    defaultValues: {
      name: zone.name,
      description: zone.description ?? '',
      zoneLeaderId: zone.zoneLeaderId ?? '',
      defaultChecklistTemplateId: zone.defaultChecklistTemplateId ?? '',
    },
  });

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<Zone>(`/zones/${zone.id}`, {
        ...body,
        // An empty select means "no leader", which is a clear rather than a no-op.
        zoneLeaderId: body.zoneLeaderId === '' ? null : body.zoneLeaderId,
        defaultChecklistTemplateId:
          body.defaultChecklistTemplateId === '' ? null : body.defaultChecklistTemplateId,
        version: zone.version,
      }),
    onSuccess: async () => {
      setFieldErrors({});
      await queryClient.invalidateQueries({ queryKey: ['zones', unitId] });
      onDone();
    },
    onError: (error) => setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {}),
  });

  return (
    <form
      className="grid gap-3 p-4 sm:grid-cols-2"
      onSubmit={handleSubmit((body) => update.mutate(body))}
    >
      <Field label="Name" error={fieldErrors.name}>
        <Input {...register('name')} />
      </Field>
      <Field
        label="Description"
        error={fieldErrors.description}
        hint="Editing this never changes a completed audit — history carries its own snapshot."
      >
        <Input {...register('description')} />
      </Field>
      <Field label="Zone Leader" error={fieldErrors.zoneLeaderId}>
        <Select {...register('zoneLeaderId')}>
          <option value="">Unassigned</option>
          {(leaders.data?.data ?? []).map((leader) => (
            <option key={leader.id} value={leader.id}>
              {leader.fullName} ({leader.loginId})
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Default checklist" error={fieldErrors.defaultChecklistTemplateId}>
        <Select {...register('defaultChecklistTemplateId')}>
          <option value="">None</option>
          {(templates.data?.data ?? []).map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-end gap-2">
        <Button type="submit" disabled={update.isPending}>
          Save
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {update.error && (
        <div className="sm:col-span-2">
          <ErrorNotice error={update.error} />
        </div>
      )}
    </form>
  );
}

function firstFreeNumber(taken: Set<string>): number {
  return zoneCodeChoices().find((choice) => !taken.has(choice.code))?.number ?? ZONE_NUMBER_MIN;
}
