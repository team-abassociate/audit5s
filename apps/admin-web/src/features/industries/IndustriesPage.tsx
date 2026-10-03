import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type {
  ChecklistTemplate,
  CreateIndustryRequest,
  Industry,
  Page,
} from '@audit5s/contracts';
import { ApiError, api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  RowActions,
  Skeleton,
  Slip,
  Spinner,
  StatusChip,
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
  const [choosing, setChoosing] = useState<string | null>(null);
  const [archivedName, setArchivedName] = useState<string | null>(null);
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

  const rows = industries.data ?? [];
  const archivedCount = rows.filter((industry) => industry.archivedAt !== null).length;

  return (
    <div className="space-y-4">
      {archivedName ? (
        <Slip title={`${archivedName} archived`} onDismiss={() => setArchivedName(null)}>
          It is no longer offered for Units or checklists. It stays on record; Show archived lists it.
        </Slip>
      ) : null}

      <Card>
        <CardHeader
          title="Industries"
          description={
            'The sector a plant operates in, and the sector a checklist belongs to. Tagging ' +
            'both means a hospital is never offered a press shop checklist. It changes what ' +
            'a screen offers — never who may see what.'
          }
          action={
            <label className="flex items-center gap-2 whitespace-nowrap text-sm text-ink-2">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              Show archived
            </label>
          }
        />

        {industries.isLoading ? (
          <Skeleton
            variant="rows"
            columns={['Industry', 'Code', 'Checklists', 'Units', '']}
            rows={4}
            label="Loading industries…"
          />
        ) : null}
        {industries.error && (
          <div className="p-4">
            <ErrorNotice error={industries.error} />
          </div>
        )}

        {industries.data && rows.length === 0 ? (
          <EmptyState title="No industries yet.">
            {canWrite ? 'Add the first one below.' : 'A Super Admin adds them.'}
          </EmptyState>
        ) : null}

        {industries.data && rows.length > 0 && (
          <Table variant="register" label="Industries">
            <thead>
              <tr>
                <Th width="31%">Industry</Th>
                <Th width="17%">Code</Th>
                <Th width="15%">Checklists</Th>
                <Th width="11%">Units</Th>
                <Th width="26%">{canWrite ? <span className="sr-only">Actions</span> : null}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((industry) => {
                const inUse = industry.templateCount > 0 || industry.unitCount > 0;
                return (
                  <Fragment key={industry.id}>
                    <tr>
                      <Td>
                        <span className="font-medium">{industry.name}</span>
                        {industry.archivedAt && (
                          <span className="ml-2">
                            <StatusChip shape="ended">Archived</StatusChip>
                          </span>
                        )}
                        {industry.description && (
                          <div className="text-xs text-ink-3">{industry.description}</div>
                        )}
                      </Td>
                      <Td className="font-mono text-xs">{industry.code}</Td>
                      <Td className="gb-data">{industry.templateCount}</Td>
                      <Td className="gb-data">{industry.unitCount}</Td>
                      <Td>
                        {canWrite && industry.archivedAt === null && (
                          <RowActions
                            subject={industry.name}
                            primary={
                              <Button
                                variant="secondary"
                                aria-expanded={choosing === industry.id}
                                onClick={() => setChoosing(choosing === industry.id ? null : industry.id)}
                              >
                                {choosing === industry.id ? 'Close' : 'Choose checklists'}
                              </Button>
                            }
                            items={[
                              {
                                label: 'Archive',
                                danger: true,
                                disabled: inUse,
                                hint: inUse
                                  ? 'Still in use. Untick its checklists and move its Units to another industry first.'
                                  : undefined,
                                confirm: {
                                  title: `Archive ${industry.name}?`,
                                  body: 'It is no longer offered for Units or checklists. It stays on record, and Show archived lists it.',
                                  confirmLabel: 'Archive',
                                  pendingLabel: 'Archiving…',
                                  run: async () => {
                                    await archive.mutateAsync(industry.id);
                                    if (choosing === industry.id) setChoosing(null);
                                    setArchivedName(industry.name);
                                  },
                                },
                              },
                            ]}
                          />
                        )}
                      </Td>
                    </tr>
                    {choosing === industry.id && (
                      <tr>
                        <td colSpan={5} className="bg-board p-0">
                          <ChooseChecklists
                            industry={industry}
                            onSaved={async () => {
                              setChoosing(null);
                              await invalidate();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}

        {/* Ticking "Show archived" with none to show must still answer (I3). */}
        {includeArchived && industries.data && rows.length > 0 && archivedCount === 0 ? (
          <EmptyState title="No archived industries." />
        ) : null}
      </Card>

      {canWrite && <AddIndustry onAdded={invalidate} />}
    </div>
  );
}

/**
 * Tick the checklists this industry is offered (0042). Ticking one here never takes it
 * away from another industry; a checklist ticked for no industry is offered to all.
 */
function ChooseChecklists({
  industry,
  onSaved,
}: {
  industry: Industry;
  onSaved: () => Promise<void>;
}) {
  const templates = useQuery({
    queryKey: ['checklist-templates', ''],
    queryFn: () => api.get<Page<ChecklistTemplate>>('/checklist-templates?limit=200'),
  });
  const [ticked, setTicked] = useState<Set<string> | null>(null);

  const current =
    ticked ??
    new Set(
      (templates.data?.data ?? [])
        .filter((template) => template.industries.some((row) => row.id === industry.id))
        .map((template) => template.id),
    );

  const save = useMutation({
    mutationFn: () =>
      api.put<Industry>(`/industries/${industry.id}/checklist-templates`, {
        templateIds: [...current],
      }),
    onSuccess: onSaved,
  });

  if (templates.isLoading) return <Spinner />;

  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-ink-2">
        Tick the checklists {industry.name} plants are offered. A checklist can serve several
        industries; one ticked for none is offered to every industry.
      </p>
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {(templates.data?.data ?? []).map((template) => {
          const others = template.industries.filter((row) => row.id !== industry.id);
          return (
            <label key={template.id} className="flex items-start gap-2 text-sm text-ink-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={current.has(template.id)}
                onChange={(event) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(template.id);
                  else next.delete(template.id);
                  setTicked(next);
                }}
              />
              <span>
                <span className="text-ink">{template.name}</span>{' '}
                <span className="font-mono text-xs text-ink-3">{template.code}</span>
                <span className="block text-xs text-ink-3">
                  {others.length > 0
                    ? `Also: ${others.map((row) => row.name).join(', ')}`
                    : template.industries.length === 0
                      ? 'Currently offered to every industry'
                      : ''}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <ErrorNotice error={save.error} />
      <Button disabled={save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : `Save ${current.size} checklist${current.size === 1 ? '' : 's'}`}
      </Button>
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
