import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type { CreateIndustryRequest, Industry } from '@audit5s/contracts';
import { ApiError, api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorNotice,
  Field,
  Input,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';

/**
 * Industries (0018) — the sectors this product is sold into.
 *
 * A label on reference data, not a tenant: it decides which checklists a Unit's audits
 * offer, and never who may see what. The page says so, because "industry" is exactly the
 * word someone would expect to mean separate customers.
 */
export function IndustriesPage() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const canWrite = can('industry', 'create');

  const industries = useQuery({
    queryKey: ['industries', includeArchived],
    queryFn: () =>
      api.get<Industry[]>(`/industries${includeArchived ? '?includeArchived=true' : ''}`),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['industries'] });
    // The catalogue and the Unit list both print the sector's name.
    await queryClient.invalidateQueries({ queryKey: ['checklist-templates'] });
    await queryClient.invalidateQueries({ queryKey: ['units'] });
  };

  const archive = useMutation({
    mutationFn: (id: string) => api.delete<Industry>(`/industries/${id}`),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Industries"
          description={
            'The sector a plant operates in, and the sector a checklist belongs to. Tagging ' +
            'both means a hospital is never offered a press shop checklist. It changes what ' +
            'a screen offers — never who may see what.'
          }
          action={
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              Show archived
            </label>
          }
        />

        {industries.isLoading && <Spinner />}
        {industries.error && (
          <div className="p-4">
            <ErrorNotice error={industries.error} />
          </div>
        )}
        {archive.error && (
          <div className="p-4">
            <ErrorNotice error={archive.error} />
          </div>
        )}

        {industries.data && (
          <Table>
            <thead>
              <tr>
                <Th>Industry</Th>
                <Th>Code</Th>
                <Th>Checklists</Th>
                <Th>Units</Th>
                <Th>{canWrite ? 'Actions' : ''}</Th>
              </tr>
            </thead>
            <tbody>
              {industries.data.map((industry) => (
                <tr key={industry.id}>
                  <Td>
                    <span className="font-medium">{industry.name}</span>
                    {industry.archivedAt && (
                      <Badge tone="neutral">
                        <span className="ml-2">archived</span>
                      </Badge>
                    )}
                    {industry.description && (
                      <div className="text-xs text-ink-3">{industry.description}</div>
                    )}
                  </Td>
                  <Td className="font-mono text-xs">{industry.code}</Td>
                  <Td>{industry.templateCount}</Td>
                  <Td>{industry.unitCount}</Td>
                  <Td>
                    {canWrite && industry.archivedAt === null && (
                      <Button
                        variant="danger"
                        disabled={archive.isPending}
                        onClick={() => archive.mutate(industry.id)}
                      >
                        Archive
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
              {industries.data.length === 0 && (
                <tr>
                  <Td className="text-ink-3">No industries yet.</Td>
                </tr>
              )}
            </tbody>
          </Table>
        )}
      </Card>

      {canWrite && <AddIndustry onAdded={invalidate} />}
    </div>
  );
}

function AddIndustry({ onAdded }: { onAdded: () => Promise<void> }) {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const { register, handleSubmit, reset } = useForm<CreateIndustryRequest>();

  const create = useMutation({
    mutationFn: (body: CreateIndustryRequest) => api.post<Industry>('/industries', body),
    onSuccess: async () => {
      setFieldErrors({});
      reset({ code: '', name: '', description: '' });
      await onAdded();
    },
    onError: (error) => {
      setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {});
    },
  });

  return (
    <Card>
      <CardHeader
        title="Add an industry"
        description="The code is permanent; the name is not. Templates and Units point at the row, but people recognise it by its code, and a code that can change means something different in two places at once."
      />
      <form
        className="grid gap-3 p-4 sm:grid-cols-2"
        onSubmit={handleSubmit((values) =>
          create.mutate({
            ...values,
            code: values.code.toUpperCase(),
            ...(values.description ? { description: values.description } : {}),
          }),
        )}
      >
        <Field label="Name" hint="e.g. Hospital" error={fieldErrors.name}>
          <Input {...register('name')} />
        </Field>
        <Field label="Code" hint="Capitals and underscores, e.g. HOSPITAL" error={fieldErrors.code}>
          <Input className="font-mono" {...register('code')} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description" error={fieldErrors.description}>
            <Input {...register('description')} />
          </Field>
        </div>

        <div className="sm:col-span-2">
          <ErrorNotice error={create.error} />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Adding…' : 'Add industry'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
