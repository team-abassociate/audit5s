import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReportAccessToken, ReportDownloadUrl, ReportSnapshot } from '@audit5s/contracts';
import { api, ApiError, fetchAll } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/cn';
import { NewReportDialog, type NewReportPreset } from './NewReportDialog';
import {
  EDITION_LABEL,
  NO_FILTERS,
  buildLibrary,
  documentTitle,
  filterLibrary,
  formatDay,
  formatWhen,
  isFiltered,
  isInFlight,
  reportName,
  unitsOf,
  type LibraryFilters,
  type ReportDocument,
  type ReportGroup,
  type StatusFilter,
  type TypeFilter,
} from './report-library';
import {
  ActionMenu,
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  ErrorNotice,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  type MenuItem,
} from '@/components/ui';

/**
 * Reports (PART 14, Phase 7's Web row): the PDFs issued to clients.
 *
 * The page is a **library**, filed the way the work happened — each audit with the Zone
 * reports issued from it, and each Unit with its summaries — and one **New report** dialog
 * that asks what to issue. It used to be a generation form stacked on a flat log of every
 * render, with a Unit selector at the top that filtered the log, steered one of the two
 * generation forms, was ignored by the other and was changed behind the user's back by it.
 *
 * Nothing is hidden for good (§10.5). A document shows its current version; every earlier
 * version is a click away, so a certification body can still be shown exactly what was
 * issued on a given date. What leaves the list is what a Super Admin took out: a report
 * cancelled before it rendered, or one deleted after (0035).
 */
export function ReportsPage() {
  const { can } = useSession();
  const mayGenerate = can('report', 'generate');

  const [filters, setFilters] = useState<LibraryFilters>(NO_FILTERS);
  const [tokensFor, setTokensFor] = useState<ReportSnapshot | null>(null);
  const [newReport, setNewReport] = useState<NewReportPreset | null>(null);
  const [openEarlier, setOpenEarlier] = useState<ReadonlySet<string>>(new Set());
  const [slip, setSlip] = useState<{ title: string; text: string } | null>(null);
  const [arrivedId, setArrivedId] = useState<string | null>(null);

  const reports = useQuery({
    queryKey: ['reports', 'all'],
    queryFn: () => fetchAll<ReportSnapshot>('/reports?limit=200'),
    // A queued report becomes ready in the background; the page notices without a reload.
    refetchInterval: (query) => ((query.state.data ?? []).some(isInFlight) ? 4_000 : 60_000),
  });

  const snapshots = useMemo(() => reports.data ?? [], [reports.data]);
  const library = useMemo(() => buildLibrary(snapshots), [snapshots]);
  const shown = useMemo(() => filterLibrary(library, filters), [library, filters]);
  const units = useMemo(() => unitsOf(snapshots), [snapshots]);
  const documentCount = shown.reduce((sum, group) => sum + group.documents.length, 0);

  /** A report was queued — by the dialog or by Regenerate. Say so, and show where it is. */
  const announce = (snapshot: ReportSnapshot, how: 'queued' | 'regenerated') => {
    setNewReport(null);
    // A filter that would hide the new report is cleared rather than leaving it invisible.
    setFilters((current) =>
      filterLibrary(buildLibrary([snapshot]), current).length > 0 ? current : NO_FILTERS,
    );
    setArrivedId(snapshot.id);
    setSlip({
      title: how === 'queued' ? 'Report queued' : 'New version queued',
      text:
        `${reportName(snapshot)} — v${snapshot.version}. It renders in the background and ` +
        'is marked Ready below when it can be downloaded; nothing has been sent to anyone.',
    });
  };

  return (
    <div className="space-y-4">
      {slip ? (
        <div className="gb-slip" role="status">
          <div className="gb-slip-row">
            <div className="min-w-0">
              <b>{slip.title}</b>
              <p>{slip.text}</p>
            </div>
            <Button variant="secondary" onClick={() => setSlip(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      <Card className="min-w-0">
        <CardHeader
          title="Issued reports"
          description="The PDFs issued to clients, filed under the audit or Unit they cover."
          action={
            mayGenerate ? <Button onClick={() => setNewReport({ mode: 'ZONE' })}>+ New report</Button> : null
          }
        />

        {snapshots.length > 0 ? (
          <FilterBar filters={filters} onChange={setFilters} units={units} count={documentCount} />
        ) : null}

        {reports.isLoading ? <Spinner /> : null}
        {reports.error ? <ErrorNotice error={reports.error} /> : null}

        {reports.data && snapshots.length === 0 ? (
          <div className="gb-empty">
            <span>No reports issued yet.</span>
            {mayGenerate ? (
              <Button onClick={() => setNewReport({ mode: 'ZONE' })}>+ New report</Button>
            ) : null}
          </div>
        ) : null}

        {reports.data && snapshots.length > 0 && shown.length === 0 ? (
          <div className="gb-empty">
            <span>No report matches these filters.</span>
            <Button variant="secondary" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </Button>
          </div>
        ) : null}

        {shown.length > 0 ? (
          <Library
            groups={shown}
            mayGenerate={mayGenerate}
            arrivedId={arrivedId}
            openEarlier={openEarlier}
            onToggleEarlier={(key) =>
              setOpenEarlier((current) => {
                const next = new Set(current);
                if (!next.delete(key)) next.add(key);
                return next;
              })
            }
            onManageTokens={setTokensFor}
            onNewReport={setNewReport}
            onRegenerated={(snapshot) => announce(snapshot, 'regenerated')}
          />
        ) : null}
      </Card>

      {mayGenerate ? (
        <NewReportDialog
          open={newReport !== null}
          preset={newReport ?? { mode: 'ZONE' }}
          snapshots={snapshots}
          onClose={() => setNewReport(null)}
          onQueued={(snapshot) => announce(snapshot, 'queued')}
        />
      ) : null}

      <LinksDialog snapshot={tokensFor} onClose={() => setTokensFor(null)} />
    </div>
  );
}

// ------------------------------------------------------------------------------ filters

function FilterBar({
  filters,
  onChange,
  units,
  count,
}: {
  filters: LibraryFilters;
  onChange: (filters: LibraryFilters) => void;
  units: Array<{ id: string; name: string }>;
  count: number;
}) {
  const set = (patch: Partial<LibraryFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="gb-filters" role="search" aria-label="Filter reports">
      {/* One Unit in scope — a Zone Leader's — has nothing to choose between. */}
      {units.length > 1 ? (
        <Field label="Unit">
          <Select value={filters.unitId} onChange={(event) => set({ unitId: event.target.value })}>
            <option value="">All Units</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Type">
        <Select value={filters.type} onChange={(event) => set({ type: event.target.value as TypeFilter })}>
          <option value="ALL">All reports</option>
          <option value="ZONE">Zone reports</option>
          <option value="SUMMARY">Unit summaries</option>
        </Select>
      </Field>
      <Field label="Status">
        <Select
          value={filters.status}
          onChange={(event) => set({ status: event.target.value as StatusFilter })}
        >
          <option value="ALL">Any status</option>
          <option value="READY">Ready</option>
          <option value="IN_PROGRESS">Queued or rendering</option>
          <option value="FAILED">Failed</option>
        </Select>
      </Field>
      <div className="gb-filters-search">
        <Field label="Search">
          <Input
            type="search"
            value={filters.search}
            onChange={(event) => set({ search: event.target.value })}
            placeholder="Zone, Unit or auditor…"
          />
        </Field>
      </div>
      <span className="gb-filters-count" aria-live="polite">
        {count} report{count === 1 ? '' : 's'}
      </span>
      {isFiltered(filters) ? (
        <Button variant="secondary" onClick={() => onChange(NO_FILTERS)}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------ library

type Pending = { snapshotId: string; action: 'regenerate' | 'delete' } | null;

function Library({
  groups,
  mayGenerate,
  arrivedId,
  openEarlier,
  onToggleEarlier,
  onManageTokens,
  onNewReport,
  onRegenerated,
}: {
  groups: ReportGroup[];
  mayGenerate: boolean;
  arrivedId: string | null;
  openEarlier: ReadonlySet<string>;
  onToggleEarlier: (documentKey: string) => void;
  onManageTokens: (snapshot: ReportSnapshot) => void;
  onNewReport: (preset: NewReportPreset) => void;
  onRegenerated: (snapshot: ReportSnapshot) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<Pending>(null);

  const regenerate = useMutation({
    mutationFn: (snapshotId: string) => api.post<ReportSnapshot>(`/reports/${snapshotId}/regenerate`),
    onMutate: () => setError(null),
    onSuccess: async (snapshot) => {
      setPending(null);
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
      onRegenerated(snapshot);
    },
    onError: setError,
  });

  // Cancel is one press: nothing was issued, and the worker simply skips it. Delete asks
  // first, in place, because it removes the PDF.
  const withdraw = useMutation({
    mutationFn: (snapshot: ReportSnapshot) =>
      api.post<ReportSnapshot>(`/reports/${snapshot.id}/${isInFlight(snapshot) ? 'cancel' : 'remove'}`),
    onMutate: () => setError(null),
    onSuccess: async () => {
      setPending(null);
      await queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: setError,
  });

  // A report just queued is brought into view once, when its row first appears.
  const shownArrival = useRef<string | null>(null);
  useEffect(() => {
    if (!arrivedId || shownArrival.current === arrivedId) return;
    const row = document.querySelector(`[data-snapshot="${arrivedId}"]`);
    if (!row) return;
    shownArrival.current = arrivedId;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  const menuFor = (snapshot: ReportSnapshot, isLatest: boolean): MenuItem[] => {
    const inFlight = isInFlight(snapshot);
    const items: MenuItem[] = [];
    if (isLatest) {
      items.push({
        label: 'Regenerate…',
        disabled: inFlight,
        hint: inFlight ? 'This version is still rendering.' : 'Issue a new version from the current data.',
        onSelect: () => setPending({ snapshotId: snapshot.id, action: 'regenerate' }),
      });
    }
    items.push({
      label: 'Links in this report',
      hint: 'See and revoke the corrective-action links this PDF prints.',
      onSelect: () => onManageTokens(snapshot),
    });
    items.push(
      inFlight
        ? {
            label: withdraw.isPending ? 'Cancelling…' : 'Cancel rendering',
            danger: true,
            disabled: withdraw.isPending,
            onSelect: () => withdraw.mutate(snapshot),
          }
        : {
            label: `Delete v${snapshot.version}…`,
            danger: true,
            onSelect: () => setPending({ snapshotId: snapshot.id, action: 'delete' }),
          },
    );
    return items;
  };

  const row = (doc: ReportDocument, snapshot: ReportSnapshot, isLatest: boolean, replacedBy?: number) => {
    const confirming = pending?.snapshotId === snapshot.id ? pending.action : null;
    return (
      <Fragment key={snapshot.id}>
        <tr
          data-snapshot={snapshot.id}
          className={cn(!isLatest && 'gb-row--earlier', snapshot.id === arrivedId && 'gb-row--target')}
        >
          <Td>
            {isLatest ? (
              <>
                <span className="gb-doc-title">{documentTitle(snapshot)}</span>
                {doc.earlier.length > 0 ? (
                  <div>
                    <button
                      type="button"
                      className="gb-earlier-toggle"
                      aria-expanded={openEarlier.has(doc.key)}
                      onClick={() => onToggleEarlier(doc.key)}
                    >
                      {openEarlier.has(doc.key)
                        ? 'Hide earlier versions'
                        : `${doc.earlier.length} earlier version${doc.earlier.length === 1 ? '' : 's'}`}
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <>Replaced by v{replacedBy}</>
            )}
          </Td>
          <Td>
            <Badge>{EDITION_LABEL[snapshot.kind]}</Badge>
          </Td>
          <Td className="gb-data">v{snapshot.version}</Td>
          <Td>
            <StatusBadge snapshot={snapshot} />
          </Td>
          <Td className="gb-data">
            <span title={`Generated by ${snapshot.generatedByName}`}>{formatWhen(snapshot.generatedAt)}</span>
          </Td>
          <Td>
            <div className="gb-row-actions">
              <DownloadButton snapshot={snapshot} primary={isLatest} onError={setError} />
              {mayGenerate ? (
                <ActionMenu label={`More actions for v${snapshot.version}`} items={menuFor(snapshot, isLatest)} />
              ) : null}
            </div>
          </Td>
        </tr>
        {confirming ? (
          <tr className="gb-row-confirm">
            <Td colSpan={COLUMNS}>
              {confirming === 'regenerate' ? (
                <div className="gb-confirm">
                  <p>
                    Regenerate from the current data? It is issued as a new version; v{snapshot.version}{' '}
                    stays in the history.
                  </p>
                  <Button variant="secondary" onClick={() => setPending(null)}>
                    Keep v{snapshot.version}
                  </Button>
                  <Button onClick={() => regenerate.mutate(snapshot.id)} disabled={regenerate.isPending}>
                    {regenerate.isPending ? 'Queuing…' : 'Regenerate'}
                  </Button>
                </div>
              ) : (
                <div className="gb-confirm">
                  <p>
                    Delete v{snapshot.version}? Its PDF is deleted for good and it leaves this list;
                    the record that it was issued is kept.
                  </p>
                  <Button variant="secondary" onClick={() => setPending(null)}>
                    Keep
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => withdraw.mutate(snapshot)}
                    disabled={withdraw.isPending}
                  >
                    {withdraw.isPending ? 'Deleting…' : `Delete v${snapshot.version}`}
                  </Button>
                </div>
              )}
            </Td>
          </tr>
        ) : null}
      </Fragment>
    );
  };

  return (
    <>
      {error ? <ErrorNotice error={error} /> : null}
      <Table>
        <thead>
          <tr>
            <Th>Report</Th>
            <Th>Edition</Th>
            <Th>Version</Th>
            <Th>Status</Th>
            <Th>Generated</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.key}>
              <tr className="gb-group">
                <Td colSpan={COLUMNS}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="gb-group-title">{group.unitName}</span>
                      <span className="gb-group-meta">{groupMeta(group)}</span>
                    </div>
                    {mayGenerate ? (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          onNewReport(
                            group.kind === 'AUDIT'
                              ? { mode: 'ZONE', auditId: group.documents[0]?.latest.auditId ?? undefined }
                              : { mode: 'SUMMARY', unitId: group.unitId },
                          )
                        }
                      >
                        {group.kind === 'AUDIT' ? 'Report another Zone' : 'New summary'}
                      </Button>
                    ) : null}
                  </div>
                </Td>
              </tr>
              {group.documents.map((doc) => (
                <Fragment key={doc.key}>
                  {row(doc, doc.latest, true)}
                  {openEarlier.has(doc.key)
                    ? doc.earlier.map((snapshot, index) =>
                        row(doc, snapshot, false, (doc.earlier[index - 1] ?? doc.latest).version),
                      )
                    : null}
                </Fragment>
              ))}
            </Fragment>
          ))}
        </tbody>
      </Table>
    </>
  );
}

const COLUMNS = 6;

function groupMeta(group: ReportGroup): string {
  if (group.kind === 'SUMMARIES') {
    return `Unit summaries · ${group.documents.length}`;
  }
  const who = group.auditorNames.length > 0 ? ` · ${group.auditorNames.join(', ')}` : '';
  return `Audit finished ${group.auditedAt ? formatWhen(group.auditedAt) : 'on an unknown date'}${who}`;
}

function StatusBadge({ snapshot }: { snapshot: ReportSnapshot }) {
  if (snapshot.status === 'READY') return <Badge tone="good">Ready</Badge>;
  if (snapshot.status === 'FAILED') {
    return (
      <span className="flex flex-col gap-0.5">
        <Badge tone="bad">Failed</Badge>
        <span className="text-xs text-ink-2">{snapshot.failedReason}</span>
      </span>
    );
  }
  if (snapshot.status === 'CANCELLED') return <Badge>Cancelled</Badge>;
  if (snapshot.status === 'REMOVED') return <Badge>Deleted</Badge>;
  return <Badge tone="warn">{snapshot.status === 'QUEUED' ? 'Queued' : 'Rendering'}</Badge>;
}

/**
 * The download.
 *
 * The PDF never transits the API: this asks for a short-TTL presigned GET and follows it.
 * The URL is fetched at click time rather than rendered into the row, so a page left open
 * does not accumulate links that outlive their five minutes.
 */
function DownloadButton({
  snapshot,
  primary,
  onError,
}: {
  snapshot: ReportSnapshot;
  primary: boolean;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    onError(null);
    try {
      const link = await api.get<ReportDownloadUrl>(`/reports/${snapshot.id}/download-url`);
      window.open(link.url, '_blank', 'noopener');
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      onClick={download}
      disabled={snapshot.status !== 'READY' || busy}
      title={snapshot.status === 'READY' ? undefined : 'Available once the report is ready.'}
    >
      {busy ? 'Preparing…' : 'Download'}
    </Button>
  );
}

// -------------------------------------------------------------------------------- links

/**
 * Token management (§8.9, §10.4), in a dialog over the list it was opened from.
 *
 * The secret is not shown and cannot be: only its hash is stored, and the raw value exists
 * in the link the PDF prints. What this offers is what a Super Admin actually needs —
 * seeing that a link has been used, and revoking one that went to the wrong person.
 */
function LinksDialog({ snapshot, onClose }: { snapshot: ReportSnapshot | null; onClose: () => void }) {
  return (
    <Dialog
      open={snapshot !== null}
      onClose={onClose}
      wide
      title={snapshot ? `Links — v${snapshot.version}` : 'Links'}
      description={
        snapshot
          ? `${reportName(snapshot)}. One link per finding, printed in the PDF. A link is never shown here — only its hash is stored.`
          : undefined
      }
    >
      {snapshot ? <TokensTable snapshot={snapshot} /> : null}
    </Dialog>
  );
}

function TokensTable({ snapshot }: { snapshot: ReportSnapshot }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<Record<string, string>>({});

  const tokens = useQuery({
    queryKey: ['report-tokens', snapshot.id],
    queryFn: () => api.get<ReportAccessToken[]>(`/reports/${snapshot.id}/tokens`),
  });

  const revoke = useMutation({
    mutationFn: (input: { tokenId: string; reason: string }) =>
      api.post<ReportAccessToken>(`/reports/${snapshot.id}/tokens/${input.tokenId}/revoke`, {
        reason: input.reason,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['report-tokens', snapshot.id] }),
  });

  return (
    <div className="gb-dialog-section">
      {tokens.isLoading ? <Spinner /> : null}
      {tokens.error ? <ErrorNotice error={tokens.error} /> : null}
      {revoke.error ? <ErrorNotice error={revoke.error} /> : null}
      {tokens.data && tokens.data.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">This report prints no links.</p>
      ) : null}
      {tokens.data && tokens.data.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Item</Th>
              <Th>Issued to</Th>
              <Th>Expires</Th>
              <Th>Uses</Th>
              <Th>Last used</Th>
              <Th>State</Th>
              <Th>Revoke</Th>
            </tr>
          </thead>
          <tbody>
            {tokens.data.map((token) => {
              const item = `${token.zoneCode ? `Zone ${token.zoneCode}` : '—'}${
                token.questionGlobalOrder ? ` · Q${token.questionGlobalOrder}` : ''
              }`;
              return (
                <tr key={token.id}>
                  <Td>{item}</Td>
                  <Td>{token.issuedToName ?? '—'}</Td>
                  {/* R-41: a link with no limit carries the last possible day. */}
                  <Td>{token.expiresAt.startsWith('9999-') ? 'Never' : formatDay(token.expiresAt)}</Td>
                  <Td className="text-right">{token.useCount}</Td>
                  <Td>{token.lastUsedAt ? formatWhen(token.lastUsedAt) : 'Never'}</Td>
                  <Td>
                    {token.revokedAt ? (
                      <span className="flex flex-col gap-0.5">
                        <Badge tone="bad">Revoked</Badge>
                        <span className="text-xs text-ink-2">{token.revokeReason}</span>
                      </span>
                    ) : token.active ? (
                      <Badge tone="good">Active</Badge>
                    ) : (
                      <Badge tone="warn">Expired</Badge>
                    )}
                  </Td>
                  <Td>
                    {token.revokedAt ? null : (
                      <div className="flex gap-1">
                        <label className="sr-only" htmlFor={`revoke-${token.id}`}>
                          Reason for revoking the link for {item}
                        </label>
                        <Input
                          id={`revoke-${token.id}`}
                          className="w-40"
                          placeholder="Reason"
                          value={reason[token.id] ?? ''}
                          onChange={(event) =>
                            setReason((current) => ({ ...current, [token.id]: event.target.value }))
                          }
                        />
                        <Button
                          variant="danger"
                          disabled={!reason[token.id]?.trim() || revoke.isPending}
                          onClick={() => revoke.mutate({ tokenId: token.id, reason: reason[token.id]!.trim() })}
                        >
                          Revoke
                        </Button>
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      ) : null}
    </div>
  );
}

/** Re-exported so a caller can branch on the shape without importing the client. */
export { ApiError };
