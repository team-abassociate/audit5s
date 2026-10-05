import { Fragment, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  AUDIT_LOG_ACTIONS,
  syncHeldLogSchema,
  syncUploadLogSchema,
  type AuditLogAction,
  type AuditLogEntry,
  type Page,
  type ReportKind,
  type User,
} from '@audit5s/contracts';
import { formatDateTime } from '@audit5s/domain';
import { api } from '@/lib/api';
import { humanize, REPORT_EDITION_LABEL, roleLabel, syncEntityLabel } from '@/lib/labels';
import { useUnits, useUnitScope } from '@/lib/scope';
import { StatusChip } from '@/components/Status';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  Select,
  Skeleton,
  Table,
  Th,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { RowToggle, rowToggleProps } from '@/features/audits/AuditsPage';
import { Changes } from './Changes';
import { isWorstCase, worstAuditLog } from './worst-case';

/** Each logged action as what the person did, in the words of the screen it happened on (L2). */
export const ACTION_LABEL: Record<AuditLogAction, string> = {
  'user.created': 'Added a person',
  'user.updated': 'Edited a person',
  'user.disabled': 'Disabled a person',
  'user.enabled': 'Re-enabled a person',
  'user.archived': 'Archived a person',
  'user.password_reset': 'Reset a password',
  'consultant.assigned': 'Gave a Consultant a Unit',
  'consultant.revoked': 'Took a Unit from a Consultant',
  'coordinator.assigned': 'Gave access to a Unit',
  'coordinator.revoked': 'Removed access to a Unit',
  'industry.created': 'Added an industry',
  'industry.updated': 'Edited an industry',
  'industry.archived': 'Archived an industry',
  'industry.checklists_changed': 'Changed an industry’s checklists',
  'zone.created': 'Added a Zone',
  'zone.updated': 'Edited a Zone',
  'zone.archived': 'Archived a Zone',
  'zone.leader_assigned': 'Set a Zone Leader',
  'checklist.imported': 'Imported a checklist',
  'checklist.translations_imported': 'Imported checklist translations',
  'checklist.translation_updated': 'Corrected a translation',
  'checklist.published': 'Published a checklist',
  'checklist.deactivated': 'Withdrew a checklist',
  'checklist.template_updated': 'Edited a checklist',
  'audit_assignment.created': 'Assigned an audit',
  'audit_assignment.cancelled': 'Cancelled an assignment',
  'audit.changed_after_completion': 'Corrected a finished audit',
  'audit.cancelled': 'Cancelled an audit',
  'audit.device_released': 'Released an audit from its phone',
  'audit.restarted': 'Restarted a finished audit',
  'report.generated': 'Generated a report',
  'report.token_revoked': 'Revoked a report link',
  'report.token_minted': 'Made another corrective-action link',
  'report.cancelled': 'Cancelled a report',
  'report.removed': 'Removed a report',
  'corrective_action.verified': 'Approved a corrective action',
  'corrective_action.reopened': 'Reopened a corrective action',
  'corrective_action.reassigned': 'Reassigned a corrective action',
  'corrective_action.raised_missing': 'Raised missed corrective actions',
  'evidence.redacted': 'Redacted a photo',
  'permission.changed': 'Changed permissions',
  'unit.created': 'Added a Unit',
  'unit.updated': 'Edited a Unit',
  'unit.archived': 'Archived a Unit',
  'device.revoked': 'Revoked a phone',
  'device.restored': 'Restored a phone',
  'device.transferred': 'Moved a phone to someone else',
  'device.user_added': 'Signed someone in on a shared phone',
  'sync_conflict.resolved': 'Decided on held field work',
  'sync.batch_received': 'Uploaded from a phone',
  'sync.item_held': 'Upload held for review',
  'audit_zone.withdrawn': 'Withdrew a Zone from an audit',
};

const RESOURCE_LABEL: Record<string, string> = {
  audit: 'Audit',
  audit_assignment: 'Assignment',
  audit_zone: 'Zone of an audit',
  checklist_template: 'Checklist',
  checklist_version: 'Checklist',
  corrective_action: 'Corrective action',
  device: 'Phone',
  device_sync_record: 'Phone upload',
  evidence: 'Photo',
  industry: 'Industry',
  report: 'Report',
  report_access_token: 'Report link',
  sync_conflict: 'Held field work',
  unit: 'Unit',
  unit_membership: 'Unit access',
  user: 'Person',
  zone: 'Zone',
};
const resourceLabel = (type: string) => RESOURCE_LABEL[type] ?? humanize(type);

/**
 * "About": the kinds of record a reviewer asks after, one option each, in their words. A kind
 * may span several tables (a checklist is a template, its versions and its translations).
 */
const ABOUT: Record<string, { label: string; types: string[] }> = {
  audit: { label: 'Audit', types: ['audit', 'audit_zone'] },
  assignment: { label: 'Assignment', types: ['audit_assignment'] },
  checklist: { label: 'Checklist', types: ['checklist_template', 'checklist_version', 'checklist_question_translation'] },
  action: { label: 'Corrective action', types: ['corrective_action'] },
  held: { label: 'Held field work', types: ['sync_conflict'] },
  industry: { label: 'Industry', types: ['industry'] },
  person: { label: 'Person', types: ['user'] },
  phone: { label: 'Phone', types: ['device'] },
  upload: { label: 'Phone upload', types: ['device_sync_record'] },
  photo: { label: 'Photo', types: ['evidence'] },
  report: { label: 'Report', types: ['report', 'report_access_token'] },
  unit: { label: 'Unit', types: ['unit'] },
  access: { label: 'Unit access', types: ['unit_membership'] },
  zone: { label: 'Zone', types: ['zone'] },
};

/** The record a row is about, by its own name where the entry carries one. */
function objectName(entry: AuditLogEntry): string | null {
  for (const side of [entry.after, entry.before]) {
    if (!side || typeof side !== 'object') continue;
    const record = side as Record<string, unknown>;
    for (const key of ['name', 'fullName', 'sheetName', 'templateCode', 'code']) {
      if (typeof record[key] === 'string' && record[key]) return record[key];
    }
    if (typeof record.version === 'number') {
      const edition = REPORT_EDITION_LABEL[record.kind as ReportKind] as string | undefined;
      // F6: entries since S15d also name the Zone; older ones carry only kind and version.
      const zone = typeof record.zoneLabel === 'string' ? ` · ${record.zoneLabel}` : '';
      return `${edition ? `${edition} · ` : ''}version ${record.version}${zone}`;
    }
    const held = syncHeldLogSchema.safeParse(record);
    if (held.success) {
      return [syncEntityLabel(held.data.entityType), held.data.zoneLabel].filter(Boolean).join(' · ');
    }
  }
  return null;
}

/** Where the record opens, for the kinds that have a page of their own. */
function objectLink(entry: AuditLogEntry) {
  if (!entry.resourceId) return null;
  switch (entry.resourceType) {
    case 'audit':
      return { to: '/audits', search: { audit: entry.resourceId } } as const;
    case 'audit_assignment':
      return { to: '/audits', search: { assignment: entry.resourceId } } as const;
    case 'user':
      return { to: '/users', search: { user: entry.resourceId } } as const;
    case 'corrective_action':
      return { to: '/corrective-actions', search: { action: entry.resourceId } } as const;
    case 'sync_conflict':
      return { to: '/sync', search: {} } as const;
    default:
      return null;
  }
}

/** The Activity log's filters, kept in the URL so a filtered view can be linked and reloaded (L1). */
export interface AuditLogSearch {
  action?: AuditLogAction;
  who?: string;
  about?: string;
  from?: string;
  to?: string;
}

const day = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

export function validateAuditLogSearch(search: Record<string, unknown>): AuditLogSearch {
  return {
    action: AUDIT_LOG_ACTIONS.includes(search.action as AuditLogAction) ? (search.action as AuditLogAction) : undefined,
    who: text(search.who),
    about: typeof search.about === 'string' && search.about in ABOUT ? search.about : undefined,
    from: day(search.from),
    to: day(search.to),
  };
}

/** An IST calendar day's first or last instant, as the API's `from` / `to` take it. */
const istBound = (key: string, end: boolean) =>
  new Date(`${key}T${end ? '23:59:59.999' : '00:00:00.000'}+05:30`).toISOString();

/**
 * The Activity log. Super Admin only, and read-only by construction: the table is
 * append-only at the database level (AL-1), so there is nothing to edit here even in
 * principle.
 *
 * Every filter asks the server (L1), so "no entries" means none exist, not "none loaded".
 * The Unit is the portal's scope, picked in the shell.
 */
export function AuditLogPage() {
  const search = useSearch({ strict: false }) as AuditLogSearch;
  const navigate = useNavigate();
  const set = (patch: Partial<AuditLogSearch>) =>
    void navigate({
      to: '.',
      search: ((prev: AuditLogSearch) => ({ ...prev, ...patch })) as never,
      replace: true,
      resetScroll: false,
    });
  const [openId, setOpenId] = useState<string | null>(null);
  const scope = useUnitScope();
  const unitId = scope.unitId;

  const query = new URLSearchParams({ limit: '100' });
  if (search.action) query.set('action', search.action);
  if (search.who) query.set('actorUserId', search.who);
  if (search.about) query.set('resourceType', ABOUT[search.about]!.types.join(','));
  if (search.from) query.set('from', istBound(search.from, false));
  if (search.to) query.set('to', istBound(search.to, true));
  if (unitId) query.set('unitId', unitId);

  const entries = useInfiniteQuery({
    queryKey: ['audit-log', query.toString()],
    // A filter change keeps the rows on screen until the new ones arrive, rather than
    // flashing the skeleton on every pick.
    placeholderData: keepPreviousData,
    enabled: scope.ready || isWorstCase(),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      if (isWorstCase()) return Promise.resolve(worstAuditLog());
      const page = new URLSearchParams(query);
      if (pageParam) page.set('cursor', pageParam);
      return api.get<Page<AuditLogEntry>>(`/audit-logs?${page}`);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = entries.data?.pages.flatMap((page) => page.data) ?? [];

  // Everyone who can act, archived people included: their past entries stay findable.
  const people = useQuery({
    queryKey: ['users', 'all'],
    queryFn: () => api.get<Page<User>>('/users?limit=200'),
    staleTime: 5 * 60_000,
    enabled: !isWorstCase(),
  });
  const actors = [...(people.data?.data ?? [])].sort((a, b) => a.fullName.localeCompare(b.fullName));
  const filtered = Boolean(search.action || search.who || search.about || search.from || search.to);
  const clear = () => set({ action: undefined, who: undefined, about: undefined, from: undefined, to: undefined });

  const actionOptions = [...AUDIT_LOG_ACTIONS].sort((a, b) => ACTION_LABEL[a].localeCompare(ACTION_LABEL[b]));

  return (
    <Card>
      <CardHeader
        title="Activity log"
        description="Every change made in the portal, and every upload from a phone: who, and when. Entries cannot be edited or removed."
      />

      <div className="gb-filters" role="search" aria-label="Filter the Activity log">
        <Field label="Action">
          <Select value={search.action ?? ''} onChange={(event) => set({ action: (event.target.value || undefined) as AuditLogAction | undefined })}>
            <option value="">All actions</option>
            {actionOptions.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Who">
          <Select className="max-w-64" value={search.who ?? ''} onChange={(event) => set({ who: event.target.value || undefined })}>
            <option value="">Anyone</option>
            {actors.map((person) => (
              <option key={person.id} value={person.id}>
                {person.fullName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="About">
          <Select value={search.about ?? ''} onChange={(event) => set({ about: event.target.value || undefined })}>
            <option value="">Anything</option>
            {Object.entries(ABOUT).map(([key, about]) => (
              <option key={key} value={key}>
                {about.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From">
          <Input type="date" value={search.from ?? ''} max={search.to} onChange={(event) => set({ from: event.target.value || undefined })} />
        </Field>
        <Field label="To">
          <Input type="date" value={search.to ?? ''} min={search.from} onChange={(event) => set({ to: event.target.value || undefined })} />
        </Field>
        {entries.data ? (
          <span className="gb-filters-count" aria-live="polite">
            {`${rows.length.toLocaleString('en-IN')}${entries.hasNextPage ? '+' : ''} entr${rows.length === 1 ? 'y' : 'ies'}`}
          </span>
        ) : null}
        {filtered ? (
          <Button variant="secondary" onClick={clear}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {entries.isLoading && <Skeleton variant="rows" columns={['When', 'Who', 'What']} label="Loading the Activity log…" />}
      {entries.error && (
        <div className="p-4">
          <ErrorNotice error={entries.error} />
        </div>
      )}

      {entries.data && rows.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No entries match these filters."
            action={
              <Button variant="secondary" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState title="Nothing logged yet." />
        )
      ) : null}

      {rows.length > 0 && (
        <Table variant="register" label="Activity log entries">
          <thead>
            <tr>
              <Th width={190}>When</Th>
              <Th width="26%">Who</Th>
              <Th>What</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <AuditLogRow
                key={entry.id}
                entry={entry}
                open={openId === entry.id}
                onToggle={() => setOpenId(openId === entry.id ? null : entry.id)}
              />
            ))}
          </tbody>
        </Table>
      )}

      {entries.hasNextPage && (
        <div className="p-4">
          <Button variant="secondary" disabled={entries.isFetchingNextPage} onClick={() => entries.fetchNextPage()}>
            {entries.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * One entry, and under it — only once opened — what changed and where the request came
 * from. The IP address is personal data, so it is shown on opening and not in the list
 * (D9). The detail is a row of its own, so opening one moves no column (L7).
 */
function AuditLogRow({ entry, open, onToggle }: { entry: AuditLogEntry; open: boolean; onToggle: () => void }) {
  const name = objectName(entry);
  const link = objectLink(entry);
  /** An entry carries its Unit's id, not its name. */
  const units = useUnits();
  const unitName = entry.unitId ? units.data?.data.find((unit) => unit.id === entry.unitId)?.name : undefined;
  const upload = entry.action === 'sync.batch_received' ? syncUploadLogSchema.safeParse(entry.after).data : undefined;

  return (
    <Fragment>
      <tr {...rowToggleProps(onToggle)} className={cn('cursor-pointer align-top', open && 'gb-row--open')}>
        <td>
          <RowToggle open={open} onClick={onToggle}>
            <span className="font-mono text-xs whitespace-nowrap">{formatDateTime(entry.occurredAt)}</span>
          </RowToggle>
        </td>
        <td>
          {entry.actorLabel}
          {entry.actorRole ? <div className="text-xs text-ink-3">{roleLabel(entry.actorRole)}</div> : null}
        </td>
        <td>
          <span className="font-medium">{ACTION_LABEL[entry.action] ?? humanize(entry.action)}</span>
          <div className="text-xs text-ink-2">
            {resourceLabel(entry.resourceType)}
            {name ? ' · ' : ''}
            {name && link ? (
              <Link to={link.to} search={link.search}>
                {name}
              </Link>
            ) : (
              name
            )}
            {!name && link ? (
              <>
                {' · '}
                <Link to={link.to} search={link.search}>
                  Open
                </Link>
              </>
            ) : null}
            {unitName && unitName !== name ? ` · ${unitName}` : null}
          </div>
          {upload ? <UploadCounts upload={upload} /> : null}
        </td>
      </tr>
      {open && (
        <tr className="gb-row--open">
          <td colSpan={3} className="bg-board">
            <div className="grid gap-4 py-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div>
                <h4 className="gb-label">What changed</h4>
                <div className="mt-1">
                  {entry.before || entry.after ? (
                    <Changes before={entry.before} after={entry.after} changedOnly />
                  ) : (
                    <p className="text-sm text-ink-3">Nothing beyond the action itself was recorded.</p>
                  )}
                </div>
              </div>
              <div>
                <h4 className="gb-label">Where it came from</h4>
                <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-3">IP address</dt>
                  <dd className="m-0 font-mono text-xs">{entry.ipAddress ?? '—'}</dd>
                  <dt className="text-ink-3">Browser or app</dt>
                  <dd className="m-0 text-xs [overflow-wrap:anywhere]">{entry.userAgent ?? '—'}</dd>
                  <dt className="text-ink-3">Request</dt>
                  <dd className="m-0 font-mono text-xs [overflow-wrap:anywhere]">{entry.requestId}</dd>
                </dl>
              </div>
            </div>
            {entry.before || entry.after ? (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-ink-2">Technical details</summary>
                <pre className="mt-1 overflow-x-auto border border-edge-soft bg-tile p-3 text-xs">
                  {JSON.stringify({ before: entry.before, after: entry.after, resourceId: entry.resourceId }, null, 2)}
                </pre>
              </details>
            ) : null}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** D11: what one upload did, in the S4 status shapes: saved, held, still to come. */
function UploadCounts({ upload }: { upload: NonNullable<ReturnType<typeof syncUploadLogSchema.safeParse>['data']> }) {
  const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      <StatusChip shape="done">
        {count(upload.applied, 'item')} saved
        {upload.photos > 0 ? `, ${count(upload.photos, 'photo')}` : ''}
      </StatusChip>
      {upload.held > 0 ? <StatusChip shape="attention">{count(upload.held, 'item')} held</StatusChip> : null}
      {upload.waiting > 0 ? <StatusChip shape="open">{count(upload.waiting, 'item')} still to come</StatusChip> : null}
    </div>
  );
}
