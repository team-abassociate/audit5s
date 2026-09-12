import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Device, Page, SyncConflict } from '@audit5s/contracts';
import { api } from '@/lib/api';
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
 * Sync health (PART 14, Phase 4's Web row): devices, the conflict queue, and what each
 * quarantined item actually contains.
 *
 * The page exists because of one sentence in §9.5: *the system has no code path that drops
 * field data on the floor*. That guarantee is only worth something if somebody can see
 * what was held and act on it — a quarantine nobody reads is a slower way of losing the
 * data. So the payload is shown in full, verbatim, rather than summarised: a Super Admin
 * deciding whether to apply a held answer needs the answer, the remark and the timestamps,
 * not a description of them.
 */
export function SyncHealthPage() {
  const [showResolved, setShowResolved] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const conflicts = useQuery({
    queryKey: ['sync-conflicts', showResolved],
    queryFn: () =>
      api.get<Page<SyncConflict>>(`/sync-conflicts?limit=200&resolved=${showResolved}`),
    // Field devices push continuously; an unresolved queue is a live view.
    refetchInterval: showResolved ? false : 30_000,
  });

  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<Page<Device>>('/devices?limit=200&includeRevoked=true'),
  });

  const unresolved = showResolved ? 0 : (conflicts.data?.data.length ?? 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Sync health"
          description={
            'Work that could not be applied is held here with its full payload — nothing is ' +
            'ever discarded. Applying an item routes through the post-completion override, ' +
            'so it is audit-logged like any other change to a finished audit.'
          }
          action={
            <Button variant="secondary" onClick={() => setShowResolved((value) => !value)}>
              {showResolved ? 'Show unresolved' : 'Show resolved'}
            </Button>
          }
        />

        {conflicts.isLoading && <Spinner />}
        {conflicts.error && (
          <div className="p-4">
            <ErrorNotice error={conflicts.error} />
          </div>
        )}

        {conflicts.data && conflicts.data.data.length === 0 && (
          <p className="px-4 pb-4 text-sm text-ink-3">
            {showResolved
              ? 'Nothing has been resolved yet.'
              : 'Nothing is waiting. Every item every device has pushed was applied.'}
          </p>
        )}

        {conflicts.data && conflicts.data.data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Held</Th>
                <Th>What</Th>
                <Th>Why</Th>
                <Th>From</Th>
                <Th>{showResolved ? 'Resolution' : ''}</Th>
              </tr>
            </thead>
            <tbody>
              {conflicts.data.data.map((conflict) => (
                <ConflictRow
                  key={conflict.id}
                  conflict={conflict}
                  expanded={expanded === conflict.id}
                  onToggle={() => setExpanded(expanded === conflict.id ? null : conflict.id)}
                />
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Devices"
          description={
            'Every device registered against a field account. Revoking one ends its sessions; ' +
            'it does not release the audits it holds — that is a separate decision, made on ' +
            'the audit.'
          }
        />
        {devices.isLoading && <Spinner />}
        {devices.error && (
          <div className="p-4">
            <ErrorNotice error={devices.error} />
          </div>
        )}
        {devices.data && <DeviceTable devices={devices.data.data} />}
      </Card>

      {unresolved > 0 && (
        <p className="text-xs text-ink-3">
          {unresolved} item{unresolved === 1 ? '' : 's'} waiting. Nothing here has been lost —
          each one is stored complete and can be applied or set aside.
        </p>
      )}
    </div>
  );
}

function ConflictRow({
  conflict,
  expanded,
  onToggle,
}: {
  conflict: SyncConflict;
  expanded: boolean;
  onToggle: () => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const resolve = useMutation({
    mutationFn: (resolution: 'APPLY' | 'DISCARD') =>
      api.post<SyncConflict>(`/sync-conflicts/${conflict.id}/resolve`, { resolution, note }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sync-conflicts'] });
      await queryClient.invalidateQueries({ queryKey: ['audits'] });
    },
  });

  return (
    <>
      <tr className="cursor-pointer hover:bg-board" onClick={onToggle}>
        <Td className="whitespace-nowrap">
          {new Date(conflict.createdAt).toLocaleString()}
        </Td>
        <Td>
          <span className="font-medium">{conflict.entityType.replace(/_/g, ' ')}</span>
          <div className="font-mono text-xs text-ink-3">{conflict.entityId}</div>
        </Td>
        <Td>
          <Badge tone={REASON_TONE[conflict.reason] ?? 'warn'}>{REASON_LABEL[conflict.reason]}</Badge>
        </Td>
        <Td>
          {conflict.userName ?? conflict.userId}
          <div className="font-mono text-xs text-ink-3">
            {conflict.deviceId ?? 'device unknown'}
          </div>
        </Td>
        <Td>
          {conflict.resolvedAt ? (
            <Badge tone={conflict.resolution === 'APPLY' ? 'good' : 'neutral'}>
              {conflict.resolution === 'APPLY' ? 'Applied' : 'Set aside'}
            </Badge>
          ) : (
            <span className="text-xs text-ink">{expanded ? 'Hide' : 'Review'}</span>
          )}
        </Td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={5} className="bg-board px-4 py-4">
            <div className="space-y-4">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-3">
                  What the device sent
                </h4>
                {/* Verbatim. A Super Admin deciding whether to apply a held answer needs
                    the answer and the auditor's own words, not a summary of them. */}
                <pre className="mt-1 overflow-x-auto border border-edge-soft bg-tile p-3 text-xs">
                  {JSON.stringify(conflict.incomingPayload, null, 2)}
                </pre>
              </div>

              {conflict.existingPayload && (
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-3">
                    What is on the server
                  </h4>
                  <pre className="mt-1 overflow-x-auto border border-edge-soft bg-tile p-3 text-xs">
                    {JSON.stringify(conflict.existingPayload, null, 2)}
                  </pre>
                </div>
              )}

              {!conflict.resolvedAt && (
                <div className="space-y-2">
                  <Field label="Why you are deciding this">
                    <Input
                      id={`note-${conflict.id}`}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Recorded in the audit log alongside the decision"
                    />
                  </Field>

                  {resolve.error && <ErrorNotice error={resolve.error} />}

                  <div className="flex gap-2">
                    <Button
                      disabled={note.trim().length === 0 || resolve.isPending}
                      onClick={() => resolve.mutate('APPLY')}
                    >
                      Apply to the audit
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={note.trim().length === 0 || resolve.isPending}
                      onClick={() => resolve.mutate('DISCARD')}
                    >
                      Set aside
                    </Button>
                  </div>

                  <p className="text-xs text-ink-3">
                    Setting aside keeps the payload — it records that you decided not to act
                    on it, not that it should be deleted. Applying it writes an audit-log
                    entry with the before and after.
                  </p>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DeviceTable({ devices }: { devices: Device[] }) {
  const queryClient = useQueryClient();

  const revoke = useMutation({
    mutationFn: (deviceId: string) => api.post<Device>(`/devices/${deviceId}/revoke`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  if (devices.length === 0) {
    return <p className="px-4 pb-4 text-sm text-ink-3">No devices have registered yet.</p>;
  }

  return (
    <>
      {revoke.error && (
        <div className="p-4">
          <ErrorNotice error={revoke.error} />
        </div>
      )}
      <Table>
        <thead>
          <tr>
            <Th>Device</Th>
            <Th>Last seen</Th>
            <Th>Last synced</Th>
            <Th>App</Th>
            <Th>{''}</Th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.id}>
              <Td>
                <span className="font-medium">{device.model ?? device.platform}</span>
                <div className="font-mono text-xs text-ink-3">{device.id}</div>
              </Td>
              <Td>{device.lastSeenAt ? relative(device.lastSeenAt) : 'never'}</Td>
              <Td>
                {device.lastSyncAt ? (
                  <StalenessBadge iso={device.lastSyncAt} />
                ) : (
                  <Badge tone="warn">never</Badge>
                )}
              </Td>
              <Td>{device.appVersion ?? '—'}</Td>
              <Td>
                {device.revokedAt ? (
                  <Badge tone="bad">revoked</Badge>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(device.id)}
                  >
                    Revoke
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

/**
 * §9.6's operational half: "a Super Admin can see *device has unsynced data, last seen N
 * days ago* and chase it — the operational half of the problem, which is usually the
 * harder half."
 *
 * A device that has not synced in two days is the one worth a phone call, so the badge
 * says so rather than printing a date the reader has to do arithmetic on.
 */
function StalenessBadge({ iso }: { iso: string }) {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  const tone = hours > 48 ? 'bad' : hours > 12 ? 'warn' : 'good';
  return <Badge tone={tone}>{relative(iso)}</Badge>;
}

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** §9.5's five reasons, in words a reviewer can act on rather than as enum tokens. */
const REASON_LABEL: Record<string, string> = {
  AUDIT_ALREADY_COMPLETED: 'Arrived after completion',
  DEVICE_NOT_OWNER: 'Sent by a second device',
  CHECKLIST_VERSION_MISMATCH: 'Question not in the pinned version',
  SCOPE_REVOKED: 'Access was revoked mid-audit',
  VALIDATION_FAILED: 'Payload could not be read',
};

const REASON_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = {
  AUDIT_ALREADY_COMPLETED: 'warn',
  DEVICE_NOT_OWNER: 'warn',
  CHECKLIST_VERSION_MISMATCH: 'bad',
  SCOPE_REVOKED: 'warn',
  VALIDATION_FAILED: 'bad',
};
