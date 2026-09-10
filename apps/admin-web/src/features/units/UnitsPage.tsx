import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type { CreateUnitRequest, Page, Unit } from '@audit5s/contracts';
import { api } from '@/lib/api';
import { Button, Card, CardHeader, ErrorNotice, Field, Input, Spinner, Table, Td, Th } from '@/components/ui';
import { useSession } from '@/lib/session';
import { UnitDetail } from './UnitDetail';

export function UnitsPage() {
  const { can } = useSession();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units'),
  });

  if (selected) {
    return <UnitDetail unitId={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Units"
          description="Every Unit you may see. A Consultant sees only their assigned Units."
          action={
            can('unit', 'create') ? (
              <Button onClick={() => setCreating((open) => !open)}>
                {creating ? 'Cancel' : 'New Unit'}
              </Button>
            ) : null
          }
        />

        {creating && <CreateUnitForm onDone={() => setCreating(false)} />}

        {units.isLoading && <Spinner />}
        {units.error && <div className="p-4"><ErrorNotice error={units.error} /></div>}

        {units.data && (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>City</Th>
                <Th>Timezone</Th>
                <Th>Geofence</Th>
              </tr>
            </thead>
            <tbody>
              {units.data.data.map((unit) => (
                <tr
                  key={unit.id}
                  className="cursor-pointer hover:bg-neutral-50"
                  onClick={() => setSelected(unit.id)}
                >
                  <Td className="font-mono text-xs">{unit.code}</Td>
                  <Td className="font-medium">{unit.name}</Td>
                  <Td>{unit.city ?? '—'}</Td>
                  <Td>{unit.timezone}</Td>
                  <Td>{unit.geofenceRadiusM === null ? 'disabled' : `${unit.geofenceRadiusM} m`}</Td>
                </tr>
              ))}
              {units.data.data.length === 0 && (
                <tr>
                  <Td className="text-neutral-500">No Units.</Td>
                </tr>
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
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
      className="grid gap-3 border-b border-neutral-200 bg-neutral-50 p-4 sm:grid-cols-2"
      onSubmit={handleSubmit((values) => create.mutate(values))}
    >
      <Field label="Code" hint="Immutable after creation — object-storage keys embed it">
        <Input placeholder="U-NASHIK" className="uppercase" {...register('code', { required: true })} />
      </Field>
      <Field label="Name">
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
