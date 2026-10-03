import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw, Trash2, X, type LucideIcon } from 'lucide-react';
import type { ReportSnapshot } from '@audit5s/contracts';
import { api, fetchAll } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/cn';
import { RowToggle, rowToggleProps } from '@/features/audits/AuditsPage';
import { REPORT_EDITION_LABEL } from '@/lib/labels';
import { formatDateTime } from '@audit5s/domain';
import { ReportPreviewPanel } from './ReportPreviewPanel';
import { NewReportDialog, type NewReportPreset } from './NewReportDialog';
import { loadReportPdf, savePdf } from './report-pdf';
import {
  NO_FILTERS,
  buildLibrary,
  documentTitle,
  filterLibrary,
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
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorNotice,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  Td,
  Th,
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
  const [previewId, setPreviewId] = useState<string | null>(null);
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

  // The rows in the order they are on screen, for ↑ / ↓ in the preview.
  const visible = useMemo(
    () =>
      shown.flatMap((group) =>
        group.documents.flatMap((doc) => (openEarlier.has(doc.key) ? [doc.latest, ...doc.earlier] : [doc.latest])),
      ),
    [shown, openEarlier],
  );
  // A report deleted while open simply leaves the panel, the same as it leaves the list.
  const previewed = snapshots.find((snapshot) => snapshot.id === previewId) ?? null;

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

      <div className={cn(previewed && 'gb-split gb-split--preview')}>
        <Card className="min-w-0">
          <CardHeader
            title="Issued reports"
            description="The PDFs issued to clients, filed under the audit or Unit they cover. Click one to preview it."
            action={
              mayGenerate ? <Button onClick={() => setNewReport({ mode: 'ZONE' })}>New report</Button> : null
            }
          />

          {snapshots.length > 0 ? (
            <FilterBar
              filters={filters}
              onChange={setFilters}
              units={units}
              count={documentCount}
            />
          ) : null}

          {reports.isLoading ? <Spinner /> : null}
          {reports.error ? <ErrorNotice error={reports.error} /> : null}

          {reports.data && snapshots.length === 0 ? (
            <div className="gb-empty">
              <span>No reports issued yet.</span>
              {mayGenerate ? (
                <Button onClick={() => setNewReport({ mode: 'ZONE' })}>New report</Button>
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
              compact={previewed !== null}
              mayGenerate={mayGenerate}
              previewId={previewed?.id ?? null}
              arrivedId={arrivedId}
              openEarlier={openEarlier}
              onToggleEarlier={(key) =>
                setOpenEarlier((current) => {
                  const next = new Set(current);
                  if (!next.delete(key)) next.add(key);
                  return next;
                })
              }
              onPreview={(snapshotId) => setPreviewId((open) => (open === snapshotId ? null : snapshotId))}
              onNewReport={setNewReport}
              onRegenerated={(snapshot) => announce(snapshot, 'regenerated')}
            />
          ) : null}
        </Card>

        {previewed ? (
          <ReportPreviewPanel
            snapshot={previewed}
            snapshots={visible}
            kindLabel={REPORT_EDITION_LABEL}
            mayGenerate={mayGenerate}
            onSelect={setPreviewId}
            onClose={() => setPreviewId(null)}
          />
        ) : null}
      </div>

      {mayGenerate ? (
        <NewReportDialog
          open={newReport !== null}
          preset={newReport ?? { mode: 'ZONE' }}
          snapshots={snapshots}
          onClose={() => setNewReport(null)}
          onQueued={(snapshot) => announce(snapshot, 'queued')}
        />
      ) : null}

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
  compact,
  mayGenerate,
  previewId,
  arrivedId,
  openEarlier,
  onToggleEarlier,
  onPreview,
  onNewReport,
  onRegenerated,
}: {
  groups: ReportGroup[];
  mayGenerate: boolean;
  /** The preview is open beside the list: row actions shrink to their icons. */
  compact: boolean;
  previewId: string | null;
  arrivedId: string | null;
  openEarlier: ReadonlySet<string>;
  onToggleEarlier: (documentKey: string) => void;
  onPreview: (snapshotId: string) => void;
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

  // ↑ / ↓ in the preview walk the list; the row being previewed stays in sight.
  useEffect(() => {
    if (!previewId) return;
    document.querySelector(`[data-snapshot="${previewId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [previewId]);

  // A report just queued is brought into view once, when its row first appears.
  const shownArrival = useRef<string | null>(null);
  useEffect(() => {
    if (!arrivedId || shownArrival.current === arrivedId) return;
    const row = document.querySelector(`[data-snapshot="${arrivedId}"]`);
    if (!row) return;
    shownArrival.current = arrivedId;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });


  const row = (doc: ReportDocument, snapshot: ReportSnapshot, isLatest: boolean, replacedBy?: number) => {
    const open = snapshot.id === previewId;
    const confirming = pending?.snapshotId === snapshot.id ? pending.action : null;
    return (
      <Fragment key={snapshot.id}>
        <tr
          data-snapshot={snapshot.id}
          onClick={rowToggleProps(() => onPreview(snapshot.id)).onClick}
          className={cn(
            'cursor-pointer',
            !isLatest && 'gb-row--earlier',
            open && 'gb-row--open',
            snapshot.id === arrivedId && 'gb-row--target',
          )}
        >
          <Td>
            {isLatest ? (
              <>
                <RowToggle open={open} onClick={() => onPreview(snapshot.id)}>
                  <span className="gb-doc-title">{documentTitle(snapshot)}</span>
                </RowToggle>
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
              <RowToggle open={open} onClick={() => onPreview(snapshot.id)}>
                Replaced by v{replacedBy}
              </RowToggle>
            )}
          </Td>
          <Td>
            <Badge>{REPORT_EDITION_LABEL[snapshot.kind]}</Badge>
          </Td>
          <Td className="gb-data">v{snapshot.version}</Td>
          <Td>
            <StatusBadge snapshot={snapshot} />
          </Td>
          <Td className="gb-data">
            <span title={`Generated by ${snapshot.generatedByName}`}>{formatDateTime(snapshot.generatedAt)}</span>
          </Td>
          <Td>
            <div className="gb-row-actions">
              <DownloadButton snapshot={snapshot} primary={isLatest} compact={compact} onError={setError} />
              {mayGenerate && isLatest ? (
                <RowAction
                  icon={RefreshCw}
                  label="Regenerate"
                  compact={compact}
                  disabled={isInFlight(snapshot)}
                  hint={
                    isInFlight(snapshot)
                      ? 'This version is still rendering.'
                      : 'Issue a new version from the current data.'
                  }
                  onClick={() => setPending({ snapshotId: snapshot.id, action: 'regenerate' })}
                />
              ) : null}
              {mayGenerate && isInFlight(snapshot) ? (
                <RowAction
                  icon={X}
                  label={withdraw.isPending ? 'Cancelling…' : 'Cancel'}
                  danger
                  compact={compact}
                  disabled={withdraw.isPending}
                  hint="Stop it before it renders. Nothing was issued."
                  onClick={() => withdraw.mutate(snapshot)}
                />
              ) : null}
              {mayGenerate && !isInFlight(snapshot) ? (
                <RowAction
                  icon={Trash2}
                  label="Delete"
                  danger
                  compact={compact}
                  hint={`Delete v${snapshot.version} and its PDF. The record that it was issued is kept.`}
                  onClick={() => setPending({ snapshotId: snapshot.id, action: 'delete' })}
                />
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
  return `Audit finished ${group.auditedAt ? formatDateTime(group.auditedAt) : 'on an unknown date'}${who}`;
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
 * The PDF never transits the API: this asks for a short-TTL presigned GET, fetches the bytes
 * and saves them under the report's own name (`Unit - Zone - kind - date - vN.pdf`). The URL
 * is minted at click time rather than rendered into the row, so a page left open does not
 * accumulate links that outlive their five minutes; a report already open in the preview is
 * saved from the bytes it holds.
 */
/** Drawn like the preview toolbar's icons: a 2px square-capped stroke in `currentColor`. */
const ROW_ICON = {
  size: 14,
  strokeWidth: 2,
  strokeLinecap: 'square',
  strokeLinejoin: 'miter',
  'aria-hidden': true,
  focusable: false,
} as const;

/**
 * One of a row's actions: icon and word while the list has the page to itself, the icon
 * alone while the preview shares it. The word is never lost — it stays the button's
 * accessible name and its tooltip.
 */
function RowAction({
  icon: Icon,
  label,
  hint,
  compact,
  danger = false,
  primary = false,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  compact: boolean;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={danger ? 'danger' : primary ? 'primary' : 'secondary'}
      className={cn('gb-btn--sm gb-btn--act', compact && 'gb-btn--act-icon')}
      disabled={disabled}
      aria-label={compact ? label : undefined}
      title={hint ? `${label} — ${hint}` : label}
      onClick={onClick}
    >
      <Icon {...ROW_ICON} />
      {compact ? null : <span>{label}</span>}
    </Button>
  );
}

function DownloadButton({
  snapshot,
  primary,
  compact,
  onError,
}: {
  snapshot: ReportSnapshot;
  primary: boolean;
  compact: boolean;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    onError(null);
    try {
      savePdf(await loadReportPdf(queryClient, snapshot));
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <RowAction
      icon={Download}
      label={busy ? 'Preparing…' : 'Download'}
      primary={primary}
      compact={compact}
      onClick={() => void download()}
      disabled={snapshot.status !== 'READY' || busy}
      hint={snapshot.status === 'READY' ? 'Save the PDF under its report name.' : 'Available once the report is ready.'}
    />
  );
}
