import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AUDIT_LOG_ACTIONS, type AuditLogEntry, type Page } from '@audit5s/contracts';
import { api } from '@/lib/api';
import { Card, CardHeader, ErrorNotice, Select, Spinner, Table, Td, Th } from '@/components/ui';

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
        title="Audit log"
        description="Append-only. Every administrative action, with the actor snapshotted as it was at the time."
        action={
          <Select className="w-64" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All actions</option>
            {AUDIT_LOG_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
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
              <tr key={entry.id} className="align-top">
                <Td className="text-xs whitespace-nowrap text-neutral-500">
                  {new Date(entry.occurredAt).toLocaleString()}
                </Td>
                <Td>
                  <div className="text-sm">{entry.actorLabel}</div>
                  {entry.ipAddress && (
                    <div className="font-mono text-xs text-neutral-400">{entry.ipAddress}</div>
                  )}
                </Td>
                <Td className="font-mono text-xs">{entry.action}</Td>
                <Td className="font-mono text-xs text-neutral-500">
                  {entry.resourceType}
                  {entry.resourceId ? `/${entry.resourceId.slice(0, 8)}…` : ''}
                </Td>
                <Td>
                  <Diff before={entry.before} after={entry.after} />
                </Td>
                <Td className="font-mono text-xs text-neutral-400">
                  {entry.requestId.slice(0, 8)}…
                </Td>
              </tr>
            ))}
            {entries.data.data.length === 0 && (
              <tr>
                <Td className="text-neutral-500">Nothing logged yet.</Td>
              </tr>
            )}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** Sensitive fields are already redacted server-side; this only renders what arrived. */
function Diff({ before, after }: { before: unknown; after: unknown }) {
  if (!before && !after) return <span className="text-xs text-neutral-400">—</span>;

  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-neutral-500">view</summary>
      <div className="mt-1 space-y-1">
        {before ? (
          <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-[11px]">
            − {JSON.stringify(before, null, 2)}
          </pre>
        ) : null}
        {after ? (
          <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-[11px]">
            + {JSON.stringify(after, null, 2)}
          </pre>
        ) : null}
      </div>
    </details>
  );
}
