import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Controller, useForm } from 'react-hook-form';
import type {
  Audit,
  ChecklistTemplate,
  CreateZoneRequest,
  CreateUserResponse,
  Page,
  Unit,
  UpdateZoneRequest,
  User,
  Zone,
  ZoneListImportResult,
  AuditorListImportResult,
} from '@audit5s/contracts';
import { ZONE_LIST_IMPORT_MAX_BYTES, ZONE_NUMBER_MIN } from '@audit5s/contracts';
import { formatDate, zoneCodeChoices, zoneCodeForLabel, zoneDisplayLabel, zoneLabelFromCode, zoneSortOrder } from '@audit5s/domain';
import { ApiError, api } from '@/lib/api';
import { devGet } from '@/features/units/worst-case';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  RowActions,
  Select,
  Spinner,
  StatusChip,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { useSession } from '@/lib/session';
import { AUDIT_TYPE_LABEL } from '@/lib/labels';
import { RowToggle, ScoreCell } from '@/features/audits/AuditsPage';
import { readAll } from '@/features/audits/data';
import { ZoneNumberInput } from './ZoneNumberInput';
import { BootstrapNotice, CreateUserForm } from '@/features/users/UsersPage';
import {
  changedZoneFields,
  editZoneDefaults,
  leaderAccountOptions,
  typedLeaderOf,
  TYPED_LEADER,
  type EditZoneValues,
} from './zone-edit';

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
    queryFn: () => devGet<Page<Zone>>(`/units/${unitId}/zones?active=false&limit=200`),
  });

  const query = search.trim().toLocaleLowerCase();
  const list = [...(zones.data?.data ?? [])]
    .filter((zone) =>
      [zoneDisplayLabel(zone.code, zone.name), zone.description, zone.zoneLeaderName].some(
        (value) => value?.toLocaleLowerCase().includes(query),
      ),
    )
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  // Every code in use, archived Zones' too: the Unit's codes are unique across both.
  const codes = (zones.data?.data ?? []).map((zone) => zone.code);

  return (
    <div className="border-t border-edge-soft bg-board">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <span className="gb-label">
          Zones{zones.data ? ` · ${list.length}` : ''}
        </span>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <Input
            type="search"
            className="max-w-xs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Zones…"
            aria-label="Search Zones"
          />
          {can('zone', 'create') && (
            <>
              <ImportZoneList unitId={unitId} />
              {can('user', 'create') && <ImportAuditorList unitId={unitId} />}
              <Button variant="secondary" onClick={() => setCreating((open) => !open)}>
                {creating ? 'Cancel' : 'New Zone'}
              </Button>
            </>
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
        <EmptyState title={query ? 'No matching Zones.' : 'No Zones in this Unit yet.'}>
          {query
            ? null
            : can('zone', 'create')
              ? 'Import the Zone list, or add one with New Zone.'
              : 'An auditor adds one by naming it in the field.'}
        </EmptyState>
      )}

      {list.length > 0 && (
        <div className="[&_table]:min-w-[760px]!">
        <Table variant="register" label="Zones">
          <thead>
            <tr>
              <Th width="22%">Zone</Th>
              <Th width="17%">Description</Th>
              <Th width="18%">Zone Leader</Th>
              <Th width="13%">Default checklist</Th>
              <Th width="13%">Status</Th>
              <Th width="17%"><span className="sr-only">Actions</span></Th>
            </tr>
          </thead>
          <tbody>
            {list.map((zone) => (
              <ZoneRow key={zone.id} zone={zone} unitId={unitId} codes={codes} />
            ))}
          </tbody>
        </Table>
        </div>
      )}
    </div>
  );
}

/**
 * R-59: the Unit's Zone list from an Excel or PDF file. Zone No., Zone Name (or
 * Description) and Leader are read; a Zone's several leaders are all its leader names
 * (R-64). A second import replaces the first — Zones it leaves out are archived — so it
 * asks before the file is chosen.
 */
function ImportZoneList({ unitId }: { unitId: string }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const unit = useQuery({
    queryKey: ['unit', unitId],
    queryFn: () => api.get<Unit>(`/units/${unitId}`),
  });
  const importList = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.post<ZoneListImportResult>(`/units/${unitId}/zones/import`, form, crypto.randomUUID());
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['zones'] }),
        queryClient.invalidateQueries({ queryKey: ['unit', unitId] }),
        queryClient.invalidateQueries({ queryKey: ['users'] }),
      ]);
    },
  });
  const importedAt = unit.data?.zoneListImportedAt ?? null;
  const result = importList.data;

  return (
    <>
      <a className="gb-btn" href={`${import.meta.env.BASE_URL}zone-list-template.xlsx`} download>
        Template
      </a>
      <Button
        variant="secondary"
        disabled={importList.isPending || unit.isPending}
        onClick={() => (importedAt ? setConfirming(true) : input.current?.click())}
      >
        {importList.isPending ? 'Importing…' : 'Import Zone list'}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        accept=".xlsx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setTooLarge(file.size > ZONE_LIST_IMPORT_MAX_BYTES);
          if (file.size <= ZONE_LIST_IMPORT_MAX_BYTES) importList.mutate(file);
        }}
      />
      <ConfirmDialog
        open={confirming}
        title="Replace this Unit’s Zone list?"
        confirmLabel="Choose file"
        onConfirm={() => {
          setConfirming(false);
          input.current?.click();
        }}
        onCancel={() => setConfirming(false)}
      >
        A Zone list was imported on {importedAt ? formatDate(importedAt) : ''}. The new file
        replaces it: its Zones are added or updated, and Zones not in it are archived. Their
        audits, scores and photographs stay on record.
      </ConfirmDialog>
      {(result || importList.error || tooLarge) && (
        <div className="basis-full" role="status">
          {tooLarge ? (
            <p className="gb-notice" role="alert">The file is larger than 5 MB.</p>
          ) : importList.error ? (
            <ErrorNotice error={importList.error} />
          ) : result ? (
            <>
              <span className="text-ink-2">
                Zone list imported: {result.created} added, {result.updated} updated,{' '}
                {result.archived} archived.
              </span>
              {result.notes.length > 0 && (
                <ul className="gb-notice">
                  {result.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </div>
      )}
    </>
  );
}

/**
 * R-64: the Unit's Auditor list from an Excel file — Zone No., ZL, Name and Mobile No. Each
 * named person the Unit has no account for becomes a Zone Leader with no Zone, who signs in
 * with their mobile number. It only adds people, so it asks nothing first.
 */
function ImportAuditorList({ unitId }: { unitId: string }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const importList = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.post<AuditorListImportResult>(`/units/${unitId}/auditors/import`, form, crypto.randomUUID());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });
  const result = importList.data;

  return (
    <>
      <a className="gb-btn" href={`${import.meta.env.BASE_URL}auditor-list-template.xlsx`} download>
        Auditor template
      </a>
      <Button variant="secondary" disabled={importList.isPending} onClick={() => input.current?.click()}>
        {importList.isPending ? 'Importing…' : 'Import Auditor list'}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setTooLarge(file.size > ZONE_LIST_IMPORT_MAX_BYTES);
          if (file.size <= ZONE_LIST_IMPORT_MAX_BYTES) importList.mutate(file);
        }}
      />
      {(result || importList.error || tooLarge) && (
        <div className="basis-full" role="status">
          {tooLarge ? (
            <p className="gb-notice" role="alert">The file is larger than 5 MB.</p>
          ) : importList.error ? (
            <ErrorNotice error={importList.error} />
          ) : result ? (
            <>
              <span className="text-ink-2">
                Auditor list imported: {result.created} new accounts, who sign in with their mobile
                number; {result.existing} already had one.
              </span>
              {result.notes.length > 0 && (
                <ul className="gb-notice">
                  {result.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </div>
      )}
    </>
  );
}

function ZoneRow({ zone, unitId, codes }: { zone: Zone; unitId: string; codes: readonly string[] }) {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);

  const archive = useMutation({
    mutationFn: () => api.post(`/zones/${zone.id}/archive`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['zones'] }),
  });

  const templates = useQuery({
    queryKey: ['checklist-templates'],
    queryFn: () => api.get<Page<ChecklistTemplate>>('/checklist-templates?limit=200'),
  });
  const label = zoneDisplayLabel(zone.code, zone.name);
  const template = templates.data?.data.find(
    (candidate) => candidate.id === zone.defaultChecklistTemplateId,
  );

  return (
    <>
      <tr className={zone.archivedAt ? 'opacity-60' : undefined}>
        <Td>
          <RowToggle open={history} onClick={() => setHistory((open) => !open)}>
            <span className="font-medium break-words">{label}</span>
          </RowToggle>
        </Td>
        <Td className="truncate text-ink-2">{zone.description ?? '—'}</Td>
        <Td>{zone.zoneLeaderName ?? <span className="text-ink-3">Unassigned</span>}</Td>
        <Td>{template?.name ?? '—'}</Td>
        <Td>
          {zone.archivedAt ? (
            <StatusChip shape="ended">Archived</StatusChip>
          ) : (
            <StatusChip shape="active">Active</StatusChip>
          )}
        </Td>
        <Td>
          {!zone.archivedAt && (
            <RowActions
              subject={label}
              primary={
                can('zone', 'update') ? (
                  <Button
                    variant="secondary"
                    aria-expanded={editing}
                    onClick={() => setEditing((open) => !open)}
                  >
                    {editing ? 'Close' : 'Edit'}
                  </Button>
                ) : null
              }
              items={
                can('zone', 'archive')
                  ? [
                      {
                        label: 'Archive',
                        danger: true,
                        confirm: {
                          title: `Archive ${label}?`,
                          body: 'It is no longer offered for new audits. Its audits, scores and photographs stay on record, and it stays listed here as Archived.',
                          confirmLabel: 'Archive',
                          pendingLabel: 'Archiving…',
                          run: () => archive.mutateAsync(),
                        },
                      },
                    ]
                  : []
              }
            />
          )}
        </Td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={6} className="bg-board p-0">
            <EditZoneForm zone={zone} unitId={unitId} codes={codes} onDone={() => setEditing(false)} />
          </td>
        </tr>
      )}
      {history && (
        <tr>
          <td colSpan={6} className="bg-board p-0">
            <ZoneAudits zoneId={zone.id} unitId={unitId} />
          </td>
        </tr>
      )}
    </>
  );
}

/** The day an audit happened: when it finished, else when it started, else when it was given. */
const auditDate = (audit: Audit) => audit.completedAt ?? audit.startedAt ?? audit.createdAt;

/**
 * Every audit that covered this Zone, newest first. One read of the Unit's audits, shared by
 * every Zone opened under it; `zoneIds` on each audit says which Zones it covered (R-43).
 * The score is the audit's, which for a multi-Zone audit is all its Zones together.
 */
function ZoneAudits({ zoneId, unitId }: { zoneId: string; unitId: string }) {
  const audits = useQuery({
    queryKey: ['audits', 'register', unitId],
    queryFn: () => readAll<Audit>(`/audits?limit=200&unitId=${unitId}`),
  });
  const rows = (audits.data ?? [])
    .filter((audit) => audit.zoneIds?.includes(zoneId))
    .sort((a, b) => auditDate(b).localeCompare(auditDate(a)));

  if (audits.isPending) return <Spinner />;
  if (audits.error) {
    return (
      <div className="p-4">
        <ErrorNotice error={audits.error} />
      </div>
    );
  }
  if (rows.length === 0) return <EmptyState title="No audits of this Zone yet." />;
  return (
    <Table label="Audits of this Zone">
      <thead>
        <tr>
          <Th>Date</Th>
          <Th>Auditor</Th>
          <Th>Status</Th>
          <Th>Score</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((audit) => (
          <tr key={audit.id}>
            <Td>
              <Link to="/audits" search={{ audit: audit.id } as never} className="gb-data underline">
                {formatDate(auditDate(audit))}
              </Link>
              <span className="block text-xs text-ink-3">{AUDIT_TYPE_LABEL[audit.auditType]}</span>
            </Td>
            <Td>{audit.auditorName}</Td>
            <Td>
              <StatusChip kind="audit" status={audit.status} />
            </Td>
            <Td>
              <ScoreCell audit={audit} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The Zone number — at most three letters or digits, `7` or `1A` (R-52) — sits on one line
 * with the name, and is converted to the stored code (`Z-07`, `Z-1A`) by `packages/domain`
 * so the web, the device and the reports spell it the same way.
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

  const templates = useOfferedTemplates(unitId).data;

  const leaders = useQuery({
    queryKey: ['users', 'zone-leaders', unitId],
    queryFn: () => api.get<Page<User>>(`/users?role=ZONE_LEADER&unitId=${unitId}&limit=200`),
  });

  const {
    register,
    control,
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
        code: zoneCodeForLabel(zoneNumber)!,
        sortOrder: zoneSortOrder(zoneNumber),
        defaultChecklistTemplateId: body.defaultChecklistTemplateId || undefined,
        zoneLeaderId: body.zoneLeaderId || undefined,
      }),
    onSuccess: async () => {
      setFieldErrors({});
      reset({ zoneNumber: '' });
      await queryClient.invalidateQueries({ queryKey: ['zones'] });
      onCreated();
    },
    onError: (error) => setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {}),
  });

  const numberRules = {
    required: 'Enter a Zone number',
    validate: (value: string) => {
      const code = zoneCodeForLabel(value);
      if (!code) return 'Type the Zone number, and its subzone letter if ticked';
      return !taken.has(code) || 'That Zone number is already used';
    },
  };

  return (
    <>
      <form
        className="grid gap-3 border-b border-edge-soft bg-board p-4 sm:grid-cols-2"
        onSubmit={handleSubmit((body) => create.mutate(body))}
      >
      <Controller
        control={control}
        name="zoneNumber"
        rules={numberRules}
        render={({ field }) => (
          <ZoneNumberInput value={field.value} onChange={field.onChange} error={errors.zoneNumber?.message ?? fieldErrors.code}>
            <Field label="Name" error={fieldErrors.name}>
              <Input {...register('name')} placeholder="Press shop" />
            </Field>
          </ZoneNumberInput>
        )}
      />

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
          {templates.map((template) => (
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
          forNewZone
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
  codes,
  onDone,
}: {
  zone: Zone;
  unitId: string;
  codes: readonly string[];
  onDone: () => void;
}) {
  const templates = useOfferedTemplates(unitId, zone.defaultChecklistTemplateId);
  const leaders = useQuery({
    queryKey: ['users', 'zone-leaders', unitId],
    queryFn: () => api.get<Page<User>>(`/users?role=ZONE_LEADER&unitId=${unitId}&limit=200`),
  });

  // The form mounts once its option lists are in, so each select opens on the value it
  // holds. Mounted earlier, a select whose option has not arrived shows its first option
  // ("Unassigned", "None") and keeps showing it after the list loads (U1).
  // A failed list stays `isPending` (no data yet) in TanStack Query v5, so the error is
  // checked first; otherwise a failure would leave the form spinning for ever.
  const loadError = leaders.error ?? templates.error;
  if (loadError) {
    return (
      <div className="space-y-2 p-4">
        <ErrorNotice error={loadError} />
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() => {
              void leaders.refetch();
              templates.refetch();
            }}
          >
            Try again
          </Button>
          <Button type="button" variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  if (leaders.isPending || templates.isPending) {
    return <Spinner />;
  }

  return (
    <EditZoneFields
      zone={zone}
      unitId={unitId}
      codes={codes}
      leaders={leaders.data?.data ?? []}
      templates={templates.data}
      onDone={onDone}
    />
  );
}

function EditZoneFields({
  zone,
  unitId,
  codes,
  leaders,
  templates,
  onDone,
}: {
  zone: Zone;
  unitId: string;
  codes: readonly string[];
  leaders: readonly User[];
  templates: readonly ChecklistTemplate[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const typedLeader = typedLeaderOf(zone);
  const leaderOptions = leaderAccountOptions(zone, leaders);
  const [defaultValues] = useState(() => editZoneDefaults(zone));
  const {
    register,
    control,
    handleSubmit,
    formState: { dirtyFields, errors },
  } = useForm<EditZoneValues>({ defaultValues });
  const labelRules = {
    validate: (value: string) => {
      // A code the Unit chose itself (`BOILER`) opens empty, and empty keeps it.
      if (value === '' && zoneLabelFromCode(zone.code) === null) return true;
      const code = zoneCodeForLabel(value);
      if (!code) return 'Type the Zone number, and its subzone letter if ticked';
      return code === zone.code || !codes.includes(code) || 'That Zone number is already used';
    },
  };
  const labelError = errors.label?.message;

  const update = useMutation({
    mutationFn: (body: UpdateZoneRequest) => api.patch<Zone>(`/zones/${zone.id}`, body),
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
      onSubmit={handleSubmit((values) => {
        const body = changedZoneFields(values, defaultValues, dirtyFields);
        if (!body) {
          onDone();
          return;
        }
        update.mutate({ ...body, version: zone.version });
      })}
    >
      <Controller
        control={control}
        name="label"
        rules={labelRules}
        render={({ field }) => (
          <ZoneNumberInput
            value={field.value}
            onChange={field.onChange}
            error={labelError ?? fieldErrors.code}
            hint={zoneLabelFromCode(zone.code) === null ? `Now ${zone.code}` : undefined}
          >
            <Field label="Name" error={fieldErrors.name} hint="Past audits and their reports keep the name they were taken under.">
              <Input {...register('name')} />
            </Field>
          </ZoneNumberInput>
        )}
      />
      <Field
        label="Description"
        error={fieldErrors.description}
        hint="Editing this never changes a completed audit — history carries its own snapshot."
      >
        <Input {...register('description')} />
      </Field>
      <Field
        label="Zone Leader"
        error={fieldErrors.zoneLeaderId}
        hint={
          typedLeader
            ? 'Typed by the auditor. Choose an account, or Unassigned, to replace it.'
            : undefined
        }
      >
        <Select {...register('zoneLeaderId')}>
          {typedLeader ? <option value={TYPED_LEADER}>{typedLeader}</option> : null}
          <option value="">Unassigned</option>
          {leaderOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Default checklist" error={fieldErrors.defaultChecklistTemplateId}>
        <Select {...register('defaultChecklistTemplateId')}>
          <option value="">None</option>
          {templates.map((template) => (
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

/**
 * The checklists a Zone of this Unit may default to (0042): those ticked for the Unit's
 * industry, plus those ticked for none, which are offered everywhere. A Unit with no
 * industry is offered everything. `keepId` stays in the list even when it no longer
 * fits, so editing a Zone never silently drops the choice it already has.
 */
function useOfferedTemplates(
  unitId: string,
  keepId?: string | null,
): { data: ChecklistTemplate[]; isPending: boolean; error: unknown; refetch: () => void } {
  const unit = useQuery({
    queryKey: ['unit', unitId],
    queryFn: () => api.get<Unit>(`/units/${unitId}`),
  });
  const templates = useQuery({
    queryKey: ['checklist-templates'],
    queryFn: () => api.get<Page<ChecklistTemplate>>('/checklist-templates?limit=200'),
  });
  const industryId = unit.data?.industryId ?? null;
  return {
    isPending: unit.isPending || templates.isPending,
    error: unit.error ?? templates.error,
    refetch: () => {
      void unit.refetch();
      void templates.refetch();
    },
    data: (templates.data?.data ?? []).filter(
      (template) =>
        template.id === keepId ||
        industryId === null ||
        template.industries.length === 0 ||
        template.industries.some((industry) => industry.id === industryId),
    ),
  };
}
