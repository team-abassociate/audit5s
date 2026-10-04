import { Fragment, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AUDIT_LOG_ACTIONS, type AuditLogAction, type AuditLogEntry, type Page } from '@audit5s/contracts';
import { formatDateTime, istDateKey } from '@audit5s/domain';
import { api } from '@/lib/api';
import { humanize, roleLabel } from '@/lib/labels';
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
  'report.generated': 'Generated a report',
  'report.token_revoked': 'Revoked a report link',
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

/** The record a row is about, by its own name where the entry carries one. */
function objectName(entry: AuditLogEntry): string | null {
  for (const side of [entry.after, entry.before]) {
    if (!side || typeof side !== 'object') continue;
    const record = side as Record<string, unknown>;
    for (const key of ['name', 'fullName', 'sheetName', 'templateCode', 'code']) {
      if (typeof record[key] === 'string' && record[key]) return record[key];
    }
    if (typeof record.version === 'number') return `version ${record.version}`;
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
    default:
      return null;
  }
}

interface Filters {
  actor: string;
  kind: string;
  from: string;
  to: string;
}
const NO_FILTERS: Filters = { actor: '', kind: '', from: '', to: '' };


/**
 * The Activity log. Super Admin only, and read-only by construction: the table is
 * append-only at the database level (AL-1), so there is nothing to edit here even in
 * principle.
 *
 * The action filter asks the server; who, what and when filter the entries already loaded
 * (UX audit L1 — server filters for those are S15d), and the count says so.
 */
export function AuditLogPage() {
  const [action, setAction] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);

  const entries = useInfiniteQuery({
    queryKey: ['audit-log', action],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      if (isWorstCase()) return Promise.resolve(worstAuditLog());
      const query = new URLSearchParams({ limit: '100' });
      if (action) query.set('action', action);
      if (pageParam) query.set('cursor', pageParam);
      return api.get<Page<AuditLogEntry>>(`/audit-logs?${query}`);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const loaded = entries.data?.pages.flatMap((page) => page.data) ?? [];

  const actors = [...new Set(loaded.map((entry) => entry.actorLabel))].sort((a, b) => a.localeCompare(b));
  const kinds = [...new Set(loaded.map((entry) => resourceLabel(entry.resourceType)))].sort();
  const rows = loaded.filter((entry) => {
    const day = istDateKey(entry.occurredAt) ?? '';
    return (
      (!filters.actor || entry.actorLabel === filters.actor) &&
      (!filters.kind || resourceLabel(entry.resourceType) === filters.kind) &&
      (!filters.from || day >= filters.from) &&
      (!filters.to || day <= filters.to)
    );
  });
  const filtered = action !== '' || Object.values(filters).some(Boolean);
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  const clear = () => {
    setAction('');
    setFilters(NO_FILTERS);
  };

  const actionOptions = [...AUDIT_LOG_ACTIONS].sort((a, b) => ACTION_LABEL[a].localeCompare(ACTION_LABEL[b]));

  return (
    <Card>
      <CardHeader
        title="Activity log"
        description="Every change made in the portal: who made it, and when. Entries cannot be edited or removed."
      />

      <div className="gb-filters" role="search" aria-label="Filter the Activity log">
        <Field label="Action">
          <Select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="">All actions</option>
            {actionOptions.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Who">
          <Select className="max-w-64" value={filters.actor} onChange={(event) => set({ actor: event.target.value })}>
            <option value="">Anyone</option>
            {actors.map((actor) => (
              <option key={actor} value={actor}>
                {actor}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="About">
          <Select value={filters.kind} onChange={(event) => set({ kind: event.target.value })}>
            <option value="">Anything</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From">
          <Input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => set({ from: event.target.value })} />
        </Field>
        <Field label="To">
          <Input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => set({ to: event.target.value })} />
        </Field>
        <span className="gb-filters-count" aria-live="polite">
          {rows.length === loaded.length
            ? `${loaded.length.toLocaleString('en-IN')} entr${loaded.length === 1 ? 'y' : 'ies'}`
            : `${rows.length.toLocaleString('en-IN')} of ${loaded.length.toLocaleString('en-IN')} loaded entries`}
          {entries.hasNextPage ? ' · older entries not loaded yet' : ''}
        </span>
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
          >
            {entries.hasNextPage ? 'Only the loaded entries were searched. Load older entries to look further back.' : null}
          </EmptyState>
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
          </div>
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
