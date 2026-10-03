import { Fragment, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { rowToggleProps } from '@/features/audits/AuditsPage';
import { syncEntityLabel } from '@/lib/labels';
import { formatDateTime, formatWeekdayDate } from '@audit5s/domain';
import { useSession } from '@/lib/session';

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

  // Newest first, a page at a time: the queue can outgrow any single page, and a count
  // taken from one page would under-report what is waiting.
  const conflicts = useInfiniteQuery({
    queryKey: ['sync-conflicts', showResolved],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: '100', resolved: String(showResolved) });
      if (pageParam) query.set('cursor', pageParam);
      return api.get<Page<SyncConflict>>(`/sync-conflicts?${query}`);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Field devices push continuously; an unresolved queue is a live view.
    refetchInterval: showResolved ? false : 30_000,
  });
  const rows = conflicts.data?.pages.flatMap((page) => page.data) ?? [];

  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<Page<Device>>('/devices?limit=200&includeRevoked=true'),
  });

  const unresolved = showResolved ? 0 : rows.length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Sync health"
          description={
            'Field work that could not be saved is held here, exactly as the phone sent it; ' +
            'nothing is thrown away. Applying an item changes the finished audit the same way ' +
            'a correction does, so it is recorded in the Activity log.'
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

        {conflicts.data && rows.length === 0 && (
          <p className="px-4 pb-4 text-sm text-ink-3">
            {showResolved
              ? 'Nothing has been resolved yet.'
              : 'Nothing is waiting. Every item every device has pushed was applied.'}
          </p>
        )}

        {rows.length > 0 && (
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
              {rows.map((conflict, index) => (
                <Fragment key={conflict.id}>
                  {dayOf(conflict.createdAt) !== dayOf(rows[index - 1]?.createdAt) && (
                    <tr>
                      <td
                        colSpan={5}
                        className="bg-board px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3"
                      >
                        {dayOf(conflict.createdAt)}
                      </td>
                    </tr>
                  )}
                  <ConflictRow
                    conflict={conflict}
                    expanded={expanded === conflict.id}
                    onToggle={() => setExpanded(expanded === conflict.id ? null : conflict.id)}
                  />
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}

        {conflicts.hasNextPage && (
          <div className="p-4">
            <Button
              variant="secondary"
              disabled={conflicts.isFetchingNextPage}
              onClick={() => conflicts.fetchNextPage()}
            >
              {conflicts.isFetchingNextPage ? 'Loading…' : 'Load older items'}
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Devices"
          description={
            'Every phone in the field, and everybody who has signed in on it — a phone may be ' +
            'shared. Revoking one ends every session on it; it does not release the audits ' +
            'it holds — that is a separate decision, made on the audit.'
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
          {unresolved}
          {conflicts.hasNextPage ? '+' : ''} item{unresolved === 1 ? '' : 's'} waiting. Nothing here has been lost —
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
  const { scope } = useSession();
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
      <tr className="cursor-pointer hover:bg-board" onClick={rowToggleProps(onToggle).onClick}>
        <Td className="whitespace-nowrap">
          {formatDateTime(conflict.createdAt)}
        </Td>
        <Td>
          <span className="font-medium">{syncEntityLabel(conflict.entityType)}</span>
          <div className="font-mono text-xs text-ink-3">{conflict.entityId}</div>
        </Td>
        <Td>
          <Badge tone={REASON_TONE[conflict.reason] ?? 'warn'}>{REASON_LABEL[conflict.reason]}</Badge>
          {/* The server's sentence, in the list and not only under Review: the badge is a
              category, and one category covers several different refusals. The API sends a
              plain sentence only — the raw error stays in the server log (UX audit S1x). */}
          {conflict.detail && <div className="mt-1 text-xs text-ink-2">{conflict.detail}</div>}
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
                  Why it was held
                </h4>
                {/* The server's sentence. `reason` is the category; this is the rule that
                    actually refused the item. It is plain words by construction: SQL, bound
                    values and stack frames never leave the server (UX audit S1x). */}
                <p className="mt-1 text-sm text-ink">
                  {conflict.detail ?? REASON_LABEL[conflict.reason]}
                </p>
                {/* The stable code, for a Super Admin matching this row to the server log or
                    describing it to support. The code only — never the raw error. */}
                {scope?.role === 'SUPER_ADMIN' && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-ink-2">Technical details</summary>
                    <p className="mt-1 text-ink-2">
                      Reason code <code className="font-mono text-ink">{conflict.reason}</code>
                    </p>
                  </details>
                )}
              </div>

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
                    Setting aside keeps what the phone sent — it records that you decided not
                    to act on it, not that it should be deleted. Applying it writes an Activity
                    log entry with the old and new values.
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

  // Revoking stops the phone for everybody on it, so it takes a second press. It used to be
  // one click beside the table's other rows, with nothing to undo it (2026-09-28).
  const [confirming, setConfirming] = useState<string | null>(null);

  const revoke = useMutation({
    mutationFn: (deviceId: string) => api.post<Device>(`/devices/${deviceId}/revoke`),
    onSuccess: async () => {
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  const restore = useMutation({
    mutationFn: (deviceId: string) => api.post<Device>(`/devices/${deviceId}/restore`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  if (devices.length === 0) {
    return <p className="px-4 pb-4 text-sm text-ink-3">No devices have registered yet.</p>;
  }

  return (
    <>
      {(revoke.error || restore.error) && (
        <div className="p-4">
          <ErrorNotice error={revoke.error ?? restore.error} />
        </div>
      )}
      <Table>
        <thead>
          <tr>
            <Th>Device</Th>
            <Th>People on it</Th>
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
              <Td>
                {/* A phone is shared: everybody who signed in on it, newest first. */}
                {device.people.map((person) => (
                  <div key={person.userId} className={person.revokedAt ? 'text-ink-3 line-through' : ''}>
                    {person.fullName}
                    <span className="ml-1 text-xs text-ink-3">{relative(person.lastSignedInAt)}</span>
                  </div>
                ))}
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
                  <div className="flex items-center gap-2">
                    <Badge tone="bad">revoked</Badge>
                    <Button
                      variant="secondary"
                      title="Let this phone be used again. Each person signs in on it once more."
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(device.id)}
                    >
                      Restore
                    </Button>
                  </div>
                ) : confirming === device.id ? (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="danger"
                      title="Signs out everybody on this phone. Use for a lost or stolen handset."
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(device.id)}
                    >
                      {revoke.isPending ? 'Revoking…' : 'Confirm revoke'}
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                  </div>
                ) : (
                  <Button variant="secondary" onClick={() => setConfirming(device.id)}>
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

/** The IST calendar day a row was held on, as the heading above that day's rows. */
function dayOf(iso: string | undefined): string {
  return iso ? formatWeekdayDate(iso) : '';
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
  // Not only a revoked Unit: the server files every "not found" and "not allowed" refusal
  // under this code (`sync-batch.service.ts`), so it read as an administrator having cut
  // somebody off when nobody had (2026-09-28). The row's own sentence says which it was.
  SCOPE_REVOKED: 'Refused: not found or not allowed',
  // Not only a malformed payload: the server also files its own failures here — a database
  // error while saving — so "could not be read" blamed the device for the server's fault
  // (UX audit S1x). The row's sentence says which it was.
  VALIDATION_FAILED: 'Could not be applied',
};

const REASON_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad'> = {
  AUDIT_ALREADY_COMPLETED: 'warn',
  DEVICE_NOT_OWNER: 'warn',
  CHECKLIST_VERSION_MISMATCH: 'bad',
  SCOPE_REVOKED: 'warn',
  VALIDATION_FAILED: 'bad',
};
