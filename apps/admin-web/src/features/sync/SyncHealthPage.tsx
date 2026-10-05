import { Fragment, useId, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { SYNC_CONFLICT_REASONS, type Device, type Page, type SyncConflict, type SyncConflictReason, type SyncConflictSummary, type User } from '@audit5s/contracts';
import { formatAge, formatDateTime, formatWeekdayDate } from '@audit5s/domain';
import { api } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  RowActions,
  Select,
  Skeleton,
  StatusChip,
  Table,
  Th,
} from '@/components/ui';
import { rowToggleProps } from '@/features/audits/AuditsPage';
import { Changes, readable } from '@/features/audit-log/Changes';
import { isWorstCase } from '@/features/audit-log/worst-case';
import { humanize, syncEntityLabel } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { useUnitScope } from '@/lib/scope';
import { cn } from '@/lib/cn';
import { worstConflicts, worstDevices } from './worst-case';

/**
 * Sync health (PART 14, Phase 4's Web row): devices, the conflict queue, and what each
 * quarantined item actually contains.
 *
 * The page exists because of one sentence in §9.5: *the system has no code path that drops
 * field data on the floor*. That guarantee is only worth something if somebody can see
 * what was held and act on it — a quarantine nobody reads is a slower way of losing the
 * data. So every field the phone sent is shown, in words (UX audit S4x); the verbatim JSON
 * stays one click away under "Technical details" for a Super Admin.
 *
 * Person, phone, reason and the portal's Unit filter on the server (S3x, S15d), and live in
 * the URL. `?device=` arrives from a "field work held" notification (N3).
 */
export interface SyncSearch {
  device?: string;
  person?: string;
  reason?: SyncConflictReason;
  resolved?: true;
}

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

export function validateSyncSearch(search: Record<string, unknown>): SyncSearch {
  return {
    device: text(search.device),
    person: text(search.person),
    reason: SYNC_CONFLICT_REASONS.includes(search.reason as SyncConflictReason)
      ? (search.reason as SyncConflictReason)
      : undefined,
    resolved: search.resolved === true || search.resolved === 'true' ? true : undefined,
  };
}

export function SyncHealthPage() {
  const search = useSearch({ strict: false }) as SyncSearch;
  const navigate = useNavigate();
  const set = (patch: Partial<SyncSearch>) =>
    void navigate({
      to: '.',
      search: ((prev: SyncSearch) => ({ ...prev, ...patch })) as never,
      replace: true,
      resetScroll: false,
    });
  const showResolved = search.resolved === true;
  const [expanded, setExpanded] = useState<string | null>(null);
  const scope = useUnitScope();

  const query = new URLSearchParams({ limit: '100', resolved: String(showResolved) });
  if (search.person) query.set('userId', search.person);
  if (search.device) query.set('deviceId', search.device);
  if (search.reason) query.set('reason', search.reason);
  if (scope.unitId) query.set('unitId', scope.unitId);

  // Newest first, a page at a time: the queue can outgrow any single page, and a count
  // taken from one page would under-report what is waiting.
  const conflicts = useInfiniteQuery({
    queryKey: ['sync-conflicts', query.toString()],
    // A filter change keeps the rows on screen until the new ones arrive, rather than
    // flashing the skeleton on every pick.
    placeholderData: keepPreviousData,
    enabled: scope.ready || isWorstCase(),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      if (isWorstCase()) return Promise.resolve(worstConflicts(showResolved));
      const page = new URLSearchParams(query);
      if (pageParam) page.set('cursor', pageParam);
      return api.get<Page<SyncConflict>>(`/sync-conflicts?${page}`);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Field devices push continuously; an unresolved queue is a live view.
    refetchInterval: showResolved ? false : 30_000,
  });
  const rows = conflicts.data?.pages.flatMap((page) => page.data) ?? [];

  // CA10: the queue's count, oldest item and per-phone counts over every matching item,
  // from the server — never counted from the pages loaded so far.
  const filters = new URLSearchParams(query);
  filters.delete('limit');
  const totals = useQuery({
    queryKey: ['sync-conflicts', 'summary', filters.toString()],
    placeholderData: keepPreviousData,
    enabled: scope.ready || isWorstCase(),
    queryFn: () =>
      isWorstCase()
        ? Promise.resolve(summarize(worstConflicts(showResolved).data))
        : api.get<SyncConflictSummary>(`/sync-conflicts/summary?${filters}`),
    refetchInterval: showResolved ? false : 30_000,
  });

  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () =>
      isWorstCase() ? Promise.resolve(worstDevices()) : api.get<Page<Device>>('/devices?limit=200&includeRevoked=true'),
  });
  const deviceById = new Map((devices.data?.data ?? []).map((device) => [device.id, device]));
  const phoneName = (id: string | null) => {
    const device = id ? deviceById.get(id) : undefined;
    return device ? (device.model ?? humanize(device.platform)) : 'Unknown phone';
  };

  const users = useQuery({
    queryKey: ['users', 'all'],
    queryFn: () => api.get<Page<User>>('/users?limit=200'),
    staleTime: 5 * 60_000,
    enabled: !isWorstCase(),
  });
  const people = [...(users.data?.data ?? [])].sort((a, b) => a.fullName.localeCompare(b.fullName));
  const phones = [...deviceById.keys()];
  if (search.device && !deviceById.has(search.device)) phones.push(search.device);
  // Four phones of one model read alike; the id's tail tells them apart (Technical details show it whole).
  const phoneOption = (id: string) =>
    phones.filter((other) => phoneName(other) === phoneName(id)).length > 1
      ? `${phoneName(id)} · …${id.slice(-4)}`
      : phoneName(id);

  const filtered = Boolean(search.person || search.device || search.reason);
  const clear = () => set({ person: undefined, device: undefined, reason: undefined });

  // Per phone, only when the queue is unfiltered: a filtered count is not the phone's whole queue.
  const heldByDevice = new Map<string, number>(
    !showResolved && !filtered && scope.unitId === null
      ? (totals.data?.byDevice ?? []).map((d) => [d.deviceId, d.count])
      : [],
  );

  // "30 held · oldest 12 days": the two numbers someone chasing the queue needs (S3x).
  const age = totals.data?.oldestAt ? formatAge(totals.data.oldestAt) : null;
  const count = (totals.data?.count ?? rows.length).toLocaleString('en-IN');
  const summary = showResolved
    ? `${count} resolved`
    : `${count} held${age ? ` · oldest ${age === 'today' ? 'from today' : `${age} old`}` : ''}`;

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
            <Button variant="secondary" onClick={() => set({ resolved: showResolved ? undefined : true })}>
              {showResolved ? 'Show unresolved' : 'Show resolved'}
            </Button>
          }
        />

        <div className="gb-filters" role="search" aria-label="Filter held field work">
          <Field label="Person">
            <Select className="max-w-64" value={search.person ?? ''} onChange={(event) => set({ person: event.target.value || undefined })}>
              <option value="">Everyone</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Phone">
            <Select className="max-w-64" value={search.device ?? ''} onChange={(event) => set({ device: event.target.value || undefined })}>
              <option value="">Every phone</option>
              {phones.map((id) => (
                <option key={id} value={id}>
                  {phoneOption(id)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Why">
            <Select value={search.reason ?? ''} onChange={(event) => set({ reason: (event.target.value || undefined) as SyncConflictReason | undefined })}>
              <option value="">Any reason</option>
              {SYNC_CONFLICT_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {REASON_LABEL[reason]}
                </option>
              ))}
            </Select>
          </Field>
          {conflicts.data ? (
            <span className="gb-filters-count" aria-live="polite">
              {summary}
            </span>
          ) : null}
          {filtered ? (
            <Button variant="secondary" onClick={clear}>
              Clear filters
            </Button>
          ) : null}
        </div>

        {conflicts.isLoading && (
          <Skeleton variant="rows" columns={['Held', 'What', 'Why', 'From']} label="Loading held field work…" />
        )}
        {conflicts.error && (
          <div className="p-4">
            <ErrorNotice error={conflicts.error} />
          </div>
        )}

        {conflicts.data && rows.length === 0 ? (
          filtered ? (
            <EmptyState
              title="Nothing held matches these filters."
              action={
                <Button variant="secondary" onClick={clear}>
                  Clear filters
                </Button>
              }
            />
          ) : showResolved ? (
            <EmptyState title="Nothing has been resolved yet." />
          ) : (
            <EmptyState title="Nothing is waiting.">Every item every phone has sent was applied.</EmptyState>
          )
        ) : null}

        {rows.length > 0 && (
          <Table variant="register" label="Held field work">
            <thead>
              <tr>
                <Th width={170}>Held</Th>
                <Th width="18%">What</Th>
                <Th>Why</Th>
                <Th width="22%">From</Th>
                <Th width={90}>{showResolved ? 'Resolution' : ''}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((conflict, index) => (
                <Fragment key={conflict.id}>
                  {dayOf(conflict.createdAt) !== dayOf(rows[index - 1]?.createdAt) && (
                    <tr className="gb-group">
                      <td colSpan={5} className="gb-group-title">
                        {dayOf(conflict.createdAt)}
                      </td>
                    </tr>
                  )}
                  <ConflictRow
                    conflict={conflict}
                    phoneName={phoneName(conflict.deviceId)}
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
        {devices.isLoading && (
          <Skeleton variant="rows" columns={['Phone', 'People on it', 'Last seen', 'Last synced']} label="Loading phones…" />
        )}
        {devices.error && (
          <div className="p-4">
            <ErrorNotice error={devices.error} />
          </div>
        )}
        {devices.data && <DeviceTable devices={devices.data.data} heldByDevice={heldByDevice} />}
      </Card>
    </div>
  );
}

/**
 * Whether "Apply" can work at all (S5x), mirroring `applyThroughOverride` in the API: only a
 * held answer to a question, carrying its value, whose record the server can still find.
 * Anything else is refused there, so it is not offered here.
 */
function cannotApplyReason(conflict: SyncConflict): string | null {
  if (conflict.reason === 'SCOPE_REVOKED') {
    return 'the record it belongs to was not found, or the person who sent it can no longer change it';
  }
  if (conflict.entityType !== 'question_response') {
    return 'only an answer to a question can be applied automatically';
  }
  if (typeof conflict.incomingPayload.value !== 'string') return 'it carries no answer to apply';
  return null;
}

function ConflictRow({
  conflict,
  phoneName,
  expanded,
  onToggle,
}: {
  conflict: SyncConflict;
  phoneName: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const queryClient = useQueryClient();
  const { scope } = useSession();
  const [note, setNote] = useState('');
  const detailId = useId();
  const blocked = cannotApplyReason(conflict);

  const resolve = useMutation({
    mutationFn: (resolution: 'APPLY' | 'DISCARD') =>
      api.post<SyncConflict>(`/sync-conflicts/${conflict.id}/resolve`, { resolution, note }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sync-conflicts'] });
      await queryClient.invalidateQueries({ queryKey: ['audits'] });
    },
  });

  const existingValue = conflict.existingPayload?.value;

  return (
    <>
      <tr {...rowToggleProps(onToggle)} className={cn('cursor-pointer align-top', expanded && 'gb-row--open')}>
        <td>
          <span className="font-mono text-xs whitespace-nowrap">{formatDateTime(conflict.createdAt)}</span>
        </td>
        <td>
          <span className="font-medium">{syncEntityLabel(conflict.entityType)}</span>
          {/* F4: which Zone, which Unit, and the audit itself, so rows can be told apart. */}
          {conflict.zoneLabel || conflict.unitName ? (
            <div className="text-xs text-ink-2">
              {[conflict.zoneLabel, conflict.unitName].filter(Boolean).join(' · ')}
            </div>
          ) : null}
          {conflict.auditId ? (
            <Link
              to="/audits"
              search={{ audit: conflict.auditId }}
              className="text-xs"
            >
              Open audit
            </Link>
          ) : null}
        </td>
        <td>
          {/* The chip wraps here: the Why column is narrow at phone width, and a nowrap chip
              would run over From. */}
          <span className="gb-chip gb-chip--muted" style={{ whiteSpace: 'normal' }}>
            {REASON_LABEL[conflict.reason] ?? humanize(conflict.reason)}
          </span>
          {/* The server's sentence, in the list and not only under Review: the badge is a
              category, and one category covers several different refusals. The API sends a
              plain sentence only — the raw error stays in the server log (UX audit S1x). */}
          {conflict.detail && <div className="mt-1 text-xs text-ink-2">{conflict.detail}</div>}
        </td>
        <td>
          {conflict.userName ?? 'Unknown person'}
          <div className="text-xs text-ink-3">{phoneName}</div>
        </td>
        <td>
          {conflict.resolvedAt ? (
            conflict.resolution === 'APPLY' ? (
              <StatusChip shape="done">Applied</StatusChip>
            ) : (
              <StatusChip shape="ended">Set aside</StatusChip>
            )
          ) : (
            <button
              type="button"
              className="cursor-pointer text-xs text-ink underline decoration-edge-soft underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
              aria-expanded={expanded}
              aria-controls={detailId}
              onClick={onToggle}
            >
              {expanded ? 'Hide' : 'Review'}
            </button>
          )}
        </td>
      </tr>

      {expanded && (
        <tr id={detailId} className="gb-row--open">
          <td colSpan={5} className="bg-board px-4 py-4">
            <div className="space-y-4">
              <div>
                <h4 className="gb-label">Why it was held</h4>
                <p className="mt-1 text-sm text-ink">{conflict.detail ?? REASON_LABEL[conflict.reason]}</p>
              </div>

              <div>
                <h4 className="gb-label">What the phone sent</h4>
                {conflict.existingPayload ? (
                  <p className="mt-1 text-xs text-ink-3">
                    Where the server holds something different, both are shown: the server’s value first, then the phone’s.
                  </p>
                ) : null}
                <div className="mt-2">
                  <Changes before={conflict.existingPayload} after={conflict.incomingPayload} />
                </div>
              </div>

              {!conflict.resolvedAt && (
                <div className="space-y-2">
                  {blocked ? (
                    <p className="text-sm text-ink-2">
                      This cannot be applied from here: {blocked}. If it still matters, make the change on the audit
                      itself, then set this item aside with your reason.
                    </p>
                  ) : (
                    <p className="text-sm text-ink-2">
                      Applying sets the answer to “{readable(conflict.incomingPayload.value)}”
                      {typeof existingValue === 'string' ? ` (it is “${readable(existingValue)}” now)` : ''} on the
                      finished audit, and records the change in the Activity log.
                    </p>
                  )}

                  <Field label="Your reason" hint="Required for either decision. Recorded in the Activity log.">
                    <Input id={`note-${conflict.id}`} value={note} onChange={(event) => setNote(event.target.value)} />
                  </Field>

                  {resolve.error && <ErrorNotice error={resolve.error} />}

                  <div className="flex flex-wrap gap-2">
                    {blocked ? null : (
                      <Button
                        disabled={note.trim().length === 0 || resolve.isPending}
                        onClick={() => resolve.mutate('APPLY')}
                      >
                        Apply to the audit
                      </Button>
                    )}
                    <Button
                      variant={blocked ? 'primary' : 'secondary'}
                      disabled={note.trim().length === 0 || resolve.isPending}
                      onClick={() => resolve.mutate('DISCARD')}
                    >
                      Set aside
                    </Button>
                  </div>

                  <p className="text-xs text-ink-3">
                    Setting aside keeps what the phone sent — it records that you decided not to act on it, not that
                    it should be deleted.
                  </p>
                </div>
              )}

              {/* For a Super Admin matching this row to the server log or describing it to
                  support: the stable code, the ids and the verbatim payload. Never the raw
                  error, which stays in the server log (UX audit S1x). */}
              {scope?.role === 'SUPER_ADMIN' && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-ink-2">Technical details</summary>
                  <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-ink-2">
                    <dt>Reason code</dt>
                    <dd className="m-0 font-mono text-ink">{conflict.reason}</dd>
                    <dt>Item</dt>
                    <dd className="m-0 font-mono text-ink [overflow-wrap:anywhere]">{conflict.entityId}</dd>
                    <dt>Phone</dt>
                    <dd className="m-0 font-mono text-ink [overflow-wrap:anywhere]">{conflict.deviceId ?? '—'}</dd>
                  </dl>
                  <pre className="mt-2 overflow-x-auto border border-edge-soft bg-tile p-3 text-xs">
                    {JSON.stringify(
                      { sent: conflict.incomingPayload, onServer: conflict.existingPayload },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DeviceTable({ devices, heldByDevice }: { devices: Device[]; heldByDevice: Map<string, number> }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['devices'] });

  const revoke = useMutation({
    mutationFn: (deviceId: string) => api.post<Device>(`/devices/${deviceId}/revoke`),
    onSuccess: refresh,
  });
  const restore = useMutation({
    mutationFn: (deviceId: string) => api.post<Device>(`/devices/${deviceId}/restore`),
    onSuccess: refresh,
  });

  if (devices.length === 0) {
    return <EmptyState title="No phones have registered yet." />;
  }

  return (
    <>
      {restore.error && (
        <div className="p-4">
          <ErrorNotice error={restore.error} />
        </div>
      )}
      <Table variant="register" label="Phones">
        <thead>
          <tr>
            <Th width="18%">Phone</Th>
            <Th>People on it</Th>
            <Th width={110}>Last seen</Th>
            <Th width={130}>Last synced</Th>
            <Th width={90}>App</Th>
            <Th width={100}>{''}</Th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => {
            const name = device.model ?? humanize(device.platform);
            return (
              <tr key={device.id} className="align-top">
                <td title={device.id}>
                  <span className="font-medium">{name}</span>
                  {device.revokedAt ? (
                    <div className="mt-1">
                      <StatusChip shape="ended">Revoked</StatusChip>
                    </div>
                  ) : null}
                </td>
                <td>
                  {/* A phone is shared: everybody who signed in on it, newest first. */}
                  {device.people.map((person) => (
                    <div key={person.userId} className={person.revokedAt ? 'text-ink-3 line-through' : ''}>
                      {person.fullName}
                      <span className="ml-1 text-xs text-ink-3">{relative(person.lastSignedInAt)}</span>
                    </div>
                  ))}
                </td>
                <td>{device.lastSeenAt ? relative(device.lastSeenAt) : 'Never'}</td>
                <td>
                  <SyncAge iso={device.lastSyncAt} held={heldByDevice.get(device.id) ?? 0} />
                </td>
                <td className="font-mono text-xs">{device.appVersion ?? '—'}</td>
                <td>
                  <RowActions
                    subject={name}
                    primary={
                      device.revokedAt ? (
                        <Button
                          variant="secondary"
                          title="Let this phone be used again. Each person signs in on it once more."
                          disabled={restore.isPending}
                          onClick={() => restore.mutate(device.id)}
                        >
                          Restore
                        </Button>
                      ) : undefined
                    }
                    items={
                      device.revokedAt
                        ? []
                        : [
                            {
                              label: 'Revoke',
                              danger: true,
                              confirm: {
                                title: `Revoke ${name}?`,
                                body: 'Everybody signed in on this phone is signed out. Use it for a lost or stolen handset. It can be restored later.',
                                confirmLabel: 'Revoke phone',
                                pendingLabel: 'Revoking…',
                                run: () => revoke.mutateAsync(device.id),
                              },
                            },
                          ]
                    }
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}

/**
 * §9.6's operational half: "a Super Admin can see *device has unsynced data, last seen N
 * days ago* and chase it".
 *
 * Red only for the phone worth a call: no sync for two days **and** work held from it
 * (S6x). A phone that is simply idle is not an alarm, and "never" is a fact, not a warning.
 */
function SyncAge({ iso, held }: { iso: string | null; held: number }) {
  if (!iso) return <span className="text-ink-3">Never</span>;
  const stale = held > 0 && Date.now() - Date.parse(iso) > 48 * 3_600_000;
  return (
    <>
      {stale ? <Badge tone="bad">{relative(iso)}</Badge> : relative(iso)}
      {held > 0 ? <div className="text-xs text-ink-2">{held.toLocaleString('en-IN')} held</div> : null}
    </>
  );
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
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
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

/** `?data=worst`: the summary the server would send for the fixture's rows. */
function summarize(rows: SyncConflict[]): SyncConflictSummary {
  const byDevice = new Map<string, number>();
  for (const row of rows) if (row.deviceId) byDevice.set(row.deviceId, (byDevice.get(row.deviceId) ?? 0) + 1);
  return {
    count: rows.length,
    oldestAt: rows.map((row) => row.createdAt).sort()[0] ?? null,
    byDevice: [...byDevice].map(([deviceId, count]) => ({ deviceId, count })),
  };
}
