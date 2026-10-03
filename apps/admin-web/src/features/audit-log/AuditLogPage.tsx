import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AUDIT_LOG_ACTIONS, type AuditLogEntry, type Page } from '@audit5s/contracts';
import { formatDateTime } from '@audit5s/domain';
import { api } from '@/lib/api';
import { Card, CardHeader, ErrorNotice, Field, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { cn } from '@/lib/cn';
import { rowToggleProps } from '@/features/audits/AuditsPage';

/**
 * The audit-log viewer. Super Admin only, and read-only by construction: the table is
 * append-only at the database level (AL-1), so there is nothing to edit here even in
 * principle.
 */
export function AuditLogPage() {
  const [action, setAction] = useState('');

  const entries = useQuery({
    queryKey: ['audit-log', action],
    queryFn: () =>
      api.get<Page<AuditLogEntry>>(`/audit-logs?limit=100${action ? `&action=${action}` : ''}`),
  });

  return (
    <Card>
      <CardHeader
        title="Activity log"
        description="Every change made in the portal: who made it, and when. Entries cannot be edited or removed."
        action={
          <Field label="Action">
            <Select className="w-64" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">All actions</option>
              {AUDIT_LOG_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
        }
      />

      {entries.isLoading && <Spinner />}
      {entries.error && <div className="p-4"><ErrorNotice error={entries.error} /></div>}

      {entries.data && (
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Actor</Th>
              <Th>Action</Th>
              <Th>Resource</Th>
              <Th>Change</Th>
              <Th>Request</Th>
            </tr>
          </thead>
          <tbody>
            {entries.data.data.map((entry) => (
              <AuditLogRow key={entry.id} entry={entry} />
            ))}
            {entries.data.data.length === 0 && (
              <tr>
                <Td className="text-ink-3">Nothing logged yet.</Td>
              </tr>
            )}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** A click anywhere on an entry with a change opens or closes its diff, not only on "view". */
function AuditLogRow({ entry }: { entry: AuditLogEntry }) {
  const [open, setOpen] = useState(false);
  const hasDiff = Boolean(entry.before || entry.after);
  const toggle = () => setOpen((current) => !current);

  return (
    <tr
      className={cn('align-top', hasDiff && 'cursor-pointer')}
      onClick={hasDiff ? rowToggleProps(toggle).onClick : undefined}
    >
      <Td className="text-xs whitespace-nowrap text-ink-3">
        {formatDateTime(entry.occurredAt)}
      </Td>
      <Td>
        <div className="text-sm">{entry.actorLabel}</div>
        {entry.ipAddress && <div className="font-mono text-xs text-ink-3">{entry.ipAddress}</div>}
      </Td>
      <Td className="font-mono text-xs">{entry.action}</Td>
      <Td className="font-mono text-xs text-ink-3">
        {entry.resourceType}
        {entry.resourceId ? `/${entry.resourceId.slice(0, 8)}…` : ''}
      </Td>
      <Td>
        <Diff before={entry.before} after={entry.after} open={open} />
      </Td>
      <Td className="font-mono text-xs text-ink-3">{entry.requestId.slice(0, 8)}…</Td>
    </tr>
  );
}

/**
 * Sensitive fields are already redacted server-side; this only renders what arrived. The
 * row owns `open`: the summary's own toggle is cancelled and its click bubbles to the row,
 * so mouse and keyboard both go through one path. A click inside the diff itself is a
 * reader placing a cursor in the JSON, not a request to fold it away.
 */
function Diff({ before, after, open }: { before: unknown; after: unknown; open: boolean }) {
  if (!before && !after) return <span className="text-xs text-ink-3">—</span>;

  return (
    <details className="text-xs" open={open}>
      <summary className="cursor-pointer text-ink-3" onClick={(event) => event.preventDefault()}>
        view
      </summary>
      <div className="mt-1 space-y-1" onClick={(event) => event.stopPropagation()}>
        {before ? (
          <pre className="overflow-x-auto bg-board p-2 text-[11px]">
            − {JSON.stringify(before, null, 2)}
          </pre>
        ) : null}
        {after ? (
          <pre className="overflow-x-auto bg-board p-2 text-[11px]">
            + {JSON.stringify(after, null, 2)}
          </pre>
        ) : null}
      </div>
    </details>
  );
}
