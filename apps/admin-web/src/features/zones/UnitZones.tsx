import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type {
  ChecklistTemplate,
  CreateZoneRequest,
  Page,
  User,
  Zone,
} from '@audit5s/contracts';
import { zoneCodeChoices, zoneDisplayLabel, zoneNumberFromCode } from '@audit5s/domain';
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

  const zones = useQuery({
    queryKey: ['zones', unitId],
    queryFn: () => api.get<Page<Zone>>(`/units/${unitId}/zones?active=false&limit=200`),
  });

  const list = [...(zones.data?.data ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code),
  );

  return (
    <div className="border-t border-edge-soft bg-board">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="gb-label">
          Zones{zones.data ? ` · ${list.length}` : ''}
        </span>
        {can('zone', 'create') && (
          <Button variant="secondary" onClick={() => setCreating((open) => !open)}>
            {creating ? 'Cancel' : 'New Zone'}
          </Button>
        )}
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
          No Zones in this Unit yet.{' '}
          {can('zone', 'create')
            ? 'Create the first one — auditors choose from these when they start an audit.'
            : 'A Coordinator creates them.'}
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
 * The Zone 1–100 helper.
 *
 * `brainstorm.md` describes the auditor picking "Zone 1 to Zone 100"; the stored `code` is
 * `Z-01`…`Z-100`, generated by `packages/domain` so the web, the device and the reports
 * spell it the same way. Numbers already used in this Unit are disabled rather than
 * hidden — a Coordinator looking for Zone 7 should see that it exists, not wonder where
 * it went.
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
  const taken = new Set(existing.map((zone) => zone.code));

  const templates = useQuery({
    queryKey: ['checklist-templates'],
    queryFn: () => api.get<Page<ChecklistTemplate>>('/checklist-templates?limit=200'),
  });

  const leaders = useQuery({
    queryKey: ['users', 'zone-leaders'],
    queryFn: () => api.get<Page<User>>('/users?role=ZONE_LEADER&limit=200'),
  });

  const { register, handleSubmit, reset } = useForm<CreateZoneRequest>({
    defaultValues: { code: firstFreeCode(taken) },
  });

  const create = useMutation({
    mutationFn: (body: CreateZoneRequest) =>
      api.post<Zone>(`/units/${unitId}/zones`, {
        ...body,
        sortOrder: zoneNumberFromCode(body.code) ?? undefined,
        defaultChecklistTemplateId: body.defaultChecklistTemplateId || undefined,
        zoneLeaderId: body.zoneLeaderId || undefined,
      }),
    onSuccess: async () => {
      setFieldErrors({});
      reset({ code: '' });
      await queryClient.invalidateQueries({ queryKey: ['zones', unitId] });
      onCreated();
    },
    onError: (error) => setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {}),
  });

  return (
    <form
      className="grid gap-3 border-b border-edge-soft bg-board p-4 sm:grid-cols-2"
      onSubmit={handleSubmit((body) => create.mutate(body))}
    >
      <Field label="Zone" error={fieldErrors.code} hint="Zone 1 to Zone 100">
        <Select {...register('code')}>
          {zoneCodeChoices().map((choice) => (
            <option key={choice.code} value={choice.code} disabled={taken.has(choice.code)}>
              Zone {choice.number}
              {taken.has(choice.code) ? ' — already used' : ''}
            </option>
          ))}
        </Select>
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
    queryKey: ['users', 'zone-leaders'],
    queryFn: () => api.get<Page<User>>('/users?role=ZONE_LEADER&limit=200'),
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

function firstFreeCode(taken: Set<string>): string {
  return zoneCodeChoices().find((choice) => !taken.has(choice.code))?.code ?? 'Z-01';
}
