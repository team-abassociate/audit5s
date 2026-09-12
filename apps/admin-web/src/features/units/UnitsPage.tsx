import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type { CreateUnitRequest, Page, Unit } from '@audit5s/contracts';
import { api } from '@/lib/api';
import { Button, Card, CardHeader, ErrorNotice, Field, Input, Spinner, Table, Td, Th } from '@/components/ui';
import { useSession } from '@/lib/session';
import { UnitZones } from '@/features/zones/UnitZones';
import { UnitDetail } from './UnitDetail';

export function UnitsPage() {
  const { can } = useSession();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
  });
  const query = search.trim().toLocaleLowerCase();
  const list = (units.data?.data ?? []).filter((unit) =>
    [unit.name, unit.city, unit.state].some((value) => value?.toLocaleLowerCase().includes(query)),
  );

  if (selected) {
    return <UnitDetail unitId={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Units & zones"
          description="Every Unit you may see, its Zones one click down. A Consultant sees only their assigned Units."
          action={
            can('unit', 'create') ? (
              <Button onClick={() => setCreating((open) => !open)}>
                {creating ? 'Cancel' : 'New Unit'}
              </Button>
            ) : null
          }
        />

        {creating && <CreateUnitForm onDone={() => setCreating(false)} />}

        <div className="border-b border-edge-soft bg-board p-4">
          <Field label="Search units">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, city or state…"
            />
          </Field>
        </div>

        {units.isLoading && <Spinner />}
        {units.error && <div className="p-4"><ErrorNotice error={units.error} /></div>}

        {units.data && (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>City</Th>
                <Th>Timezone</Th>
                <Th>Geofence</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((unit) => (
                <UnitRow
                  key={unit.id}
                  unit={unit}
                  expanded={expanded === unit.id}
                  onToggle={() => setExpanded(expanded === unit.id ? null : unit.id)}
                  onEdit={() => setSelected(unit.id)}
                />
              ))}
              {list.length === 0 && (
                <tr>
                  <Td className="text-ink-3">{query ? 'No matching Units.' : 'No Units.'}</Td>
                </tr>
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function UnitRow({
  unit,
  expanded,
  onToggle,
  onEdit,
}: {
  unit: Unit;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: () => api.post<void>(`/units/${unit.id}/archive`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['units'] }),
  });

  return (
    <Fragment>
      <tr>
        <Td>
          <button
            type="button"
            className="flex items-center gap-2 font-medium"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            <span className="text-ink-3" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
            {unit.name}
          </button>
        </Td>
        <Td>{unit.city ?? '—'}</Td>
        <Td>{unit.timezone}</Td>
        <Td>{unit.geofenceRadiusM === null ? 'disabled' : `${unit.geofenceRadiusM} m`}</Td>
        <Td>
          <div className="flex gap-2">
            {can('unit', 'update_profile') && (
              <Button variant="secondary" onClick={onEdit}>
                Edit
              </Button>
            )}
            {can('unit', 'archive') && (
              <Button variant="danger" disabled={archive.isPending} onClick={() => archive.mutate()}>
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
      {expanded && (
        <tr>
          <td colSpan={5} className="p-0">
            <UnitZones unitId={unit.id} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function CreateUnitForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, reset } = useForm<CreateUnitRequest>();

  const create = useMutation({
    mutationFn: (body: CreateUnitRequest) => api.post<Unit>('/units', body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['units'] });
      reset();
      onDone();
    },
  });

  return (
    <form
      className="grid gap-3 border-b border-edge-soft bg-board p-4 sm:grid-cols-2"
      onSubmit={handleSubmit((values) => create.mutate(values))}
    >
      <Field label="Name" hint="The Unit's only identifier — it must be unique">
        <Input placeholder="Nashik Plant" {...register('name', { required: true })} />
      </Field>
      <Field label="City">
        <Input {...register('city')} />
      </Field>
      <Field label="Timezone">
        <Input defaultValue="Asia/Kolkata" {...register('timezone')} />
      </Field>

      <div className="sm:col-span-2">
        <ErrorNotice error={create.error} />
      </div>

      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create Unit'}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
